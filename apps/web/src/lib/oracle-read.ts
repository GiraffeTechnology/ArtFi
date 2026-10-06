import "server-only";

import { isAddress } from "viem";
import { hoodi } from "viem/chains";

import { assetDeploymentBinding } from "./asset-binding";
import { getArtwork } from "./catalog";
import {
  oracleAssetReadSchema,
  oracleTokenReadSchema,
  type OracleReadError,
  type OracleReadResponse,
} from "./oracle-read-model";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMs = 4_000;
class ReadError extends Error {
  constructor(readonly code: OracleReadError) {
    super(code);
  }
}

// This is deployment-owned configuration, never a URL supplied by a browser. It
// may use the existing bridge's path prefix. It creates no new host or identity.
function upstreamBase() {
  const configured = process.env.ARTFI_ORACLE_READ_API_URL?.trim();
  if (!configured) throw new ReadError("ORACLE_NOT_CONFIGURED");
  try {
    const url = new URL(configured);
    const localTest =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && localTest)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid Oracle base");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/`;
    return url;
  } catch {
    throw new ReadError("ORACLE_CONFIG_INVALID");
  }
}

async function readJson(
  url: URL,
  missing: "TOKEN_NOT_FOUND" | "ASSET_NOT_FOUND",
) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ReadError("ORACLE_TIMEOUT"));
    }, requestTimeoutMs);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 404) throw new ReadError(missing);
        if (response.status === 410) throw new ReadError("ORACLE_RECORD_GONE");
        if (!response.ok) throw new ReadError("ORACLE_UNAVAILABLE");
        const length = response.headers.get("content-length");
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > maximumResponseBytes)) ||
          !response.body
        )
          throw new ReadError("ORACLE_INVALID_RESPONSE");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > maximumResponseBytes)
            throw new ReadError("ORACLE_INVALID_RESPONSE");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          ) as unknown;
        } catch {
          throw new ReadError("ORACLE_INVALID_RESPONSE");
        }
      })(),
    ]);
  } catch (error) {
    if (timedOut) throw new ReadError("ORACLE_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Do not let a broken upstream stream extend the request deadline.
    void reader?.cancel().catch(() => undefined);
  }
}

/** Existing public Oracle reads only; not a verification gate or transaction authority. */
export async function readWholeArtworkOracle(
  slug: string,
): Promise<OracleReadResponse> {
  try {
    if (!getArtwork(slug)) throw new ReadError("UNKNOWN_ASSET");
    const contract =
      process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS?.trim();
    const binding = assetDeploymentBinding(
      slug,
      process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG,
      contract,
    );
    if (!binding.bound) {
      throw new ReadError(
        binding.boundElsewhere ? "BINDING_ELSEWHERE" : "BINDING_NOT_CONFIGURED",
      );
    }
    const tokenId =
      process.env.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID?.trim();
    if (
      !contract ||
      !isAddress(contract) ||
      /^0x0{40}$/i.test(contract) ||
      !tokenId ||
      !/^(0|[1-9][0-9]{0,77})$/.test(tokenId) ||
      BigInt(tokenId) >= 2n ** 256n
    ) {
      throw new ReadError("BINDING_INVALID");
    }
    const base = upstreamBase();
    // The whole-artwork screen currently uses Hoodi. Do not choose another chain
    // or normalize Oracle's case-sensitive contract key independently of it.
    const chainId = String(hoodi.id);
    const tokenResult = oracleTokenReadSchema.safeParse(
      await readJson(
        new URL(`v1/rwa/tokens/${chainId}/${contract}/${tokenId}`, base),
        "TOKEN_NOT_FOUND",
      ),
    );
    if (!tokenResult.success) throw new ReadError("ORACLE_INVALID_RESPONSE");
    const token = tokenResult.data;
    if (
      token.binding.chainId !== chainId ||
      token.binding.contract !== contract ||
      token.binding.tokenId !== tokenId ||
      (token.currentCertificate &&
        (token.currentCertificate.assetId !== token.binding.assetId ||
          token.currentCertificate.tokenId !== tokenId))
    ) {
      throw new ReadError("BINDING_MISMATCH");
    }
    const assetResult = oracleAssetReadSchema.safeParse(
      await readJson(
        new URL(`v1/rwa/assets/${token.binding.assetId}`, base),
        "ASSET_NOT_FOUND",
      ),
    );
    if (!assetResult.success) throw new ReadError("ORACLE_INVALID_RESPONSE");
    const asset = assetResult.data;
    if (
      asset.asset.assetId !== token.binding.assetId ||
      (asset.currentCertificate &&
        (asset.currentCertificate.assetId !== token.binding.assetId ||
          asset.currentCertificate.tokenId !== tokenId)) ||
      (asset.warehouse && asset.warehouse.assetId !== token.binding.assetId)
    ) {
      throw new ReadError("BINDING_MISMATCH");
    }
    return { ok: true, token, asset, readAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ReadError ? error.code : "ORACLE_UNAVAILABLE",
    };
  }
}
