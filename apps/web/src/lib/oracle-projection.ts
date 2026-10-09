import type { RwaAsset } from "./rwa-catalog";
import { publicSetting } from "@/lib/public-runtime-config";
import "server-only";

import { isAddress } from "viem";
import { hoodi } from "viem/chains";
import { z } from "zod";

import { assetDeploymentBinding } from "./asset-binding";
import { getArtwork } from "./catalog";
import {
  projectionEntrySchema,
  projectionReadErrorSchema,
  projectionSourceSchema,
  projectionUint64,
  projectionUint256,
  type ProjectionReadError,
  type ProjectionReadResponse,
} from "./oracle-projection-model";

class ProjectionError extends Error {
  constructor(readonly code: ProjectionReadError) {
    super(code);
  }
}
function fail(code: ProjectionReadError): never {
  throw new ProjectionError(code);
}
const failure = (error: unknown) => ({
  ok: false as const,
  code:
    error instanceof ProjectionError
      ? error.code
      : ("PROJECTION_READ_UNAVAILABLE" as const),
});
const responseBase = {
  tokenId: projectionUint256,
  source: projectionSourceSchema,
};
const identitySchema = z.object({
  ...responseBase,
  registerId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  entryCount: projectionUint64,
});
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const at = { ...responseBase, instant: projectionUint64 };
const entrySchema = z.object({ ...at, entry: projectionEntrySchema });
const holderSchema = z.object({ ...at, holder: address });
const finalitySchema = z.object({ ...at, final: z.boolean() });
const positionSchema = z.object({
  ...responseBase,
  tradeablePosition: address.nullable(),
  positionSource: z.literal("erc-721"),
});
const upstreamErrors = new Set<ProjectionReadError>([
  "INSTANT_NOT_COVERED",
  "UNKNOWN_TOKEN",
  "EMPTY_PROJECTION",
  "PROJECTION_SOURCE_NOT_CONFIGURED",
  "PROJECTION_SOURCE_UNAVAILABLE",
  "PROJECTION_SOURCE_MALFORMED",
]);

function configuration(
  slug: string,
  instant: string,
  catalogBinding?: RwaAsset["binding"],
) {
  if (!catalogBinding && !getArtwork(slug)) fail("UNKNOWN_ASSET");
  if (!projectionUint64.safeParse(instant).success) fail("INSTANT_INVALID");
  const contract =
    catalogBinding?.collectionAddress ??
    publicSetting("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS")?.trim();
  const bound = assetDeploymentBinding(
    slug,
    publicSetting("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG"),
    contract,
  );
  if (!catalogBinding && !bound.bound)
    fail(bound.boundElsewhere ? "BINDING_ELSEWHERE" : "BINDING_NOT_CONFIGURED");
  const tokenId =
    catalogBinding?.tokenId ??
    publicSetting("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID")?.trim();
  if (
    !contract ||
    !isAddress(contract) ||
    /^0x0{40}$/i.test(contract) ||
    !tokenId ||
    !projectionUint256.safeParse(tokenId).success
  )
    fail("BINDING_INVALID");
  const configured = process.env.ARTFI_ORACLE_READ_API_URL?.trim();
  if (!configured) fail("ORACLE_NOT_CONFIGURED");
  let base: URL;
  try {
    base = new URL(configured);
    const localTest =
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if (
      (base.protocol !== "https:" &&
        !(base.protocol === "http:" && localTest)) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      fail("ORACLE_CONFIG_INVALID");
    base.pathname = `${base.pathname.replace(/\/$/, "")}/`;
  } catch {
    fail("ORACLE_CONFIG_INVALID");
  }
  return {
    base,
    tokenId,
    contract,
    chainId: String(catalogBinding?.chainId ?? hoodi.id),
  };
}

/** Bounded GET-only JSON transport. No request body, cookie, URL or credentials
 * supplied by the browser are forwarded to Oracle. */
async function readJson(url: URL): Promise<unknown> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProjectionError("PROJECTION_TIMEOUT"));
    }, 4_000);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        const length = response.headers.get("content-length");
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get("content-type") ?? "",
          ) ||
          (length !== null &&
            (!/^\d+$/.test(length) || Number(length) > 65_536)) ||
          !response.body
        )
          fail("PROJECTION_SOURCE_MALFORMED");
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > 65_536) fail("PROJECTION_SOURCE_MALFORMED");
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        } catch {
          fail("PROJECTION_SOURCE_MALFORMED");
        }
        if (!response.ok) {
          const parsed = z
            .object({
              ok: z.literal(false),
              errorCode: projectionReadErrorSchema,
            })
            .safeParse(value);
          if (parsed.success && upstreamErrors.has(parsed.data.errorCode))
            fail(parsed.data.errorCode);
          fail("PROJECTION_READ_UNAVAILABLE");
        }
        return value;
      })(),
    ]);
  } catch (error) {
    if (timedOut) fail("PROJECTION_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

/** Read only Oracle's application boundary. Its observations never authorize
 * issuance, settlement, redemption, or a legal-title claim. */
export async function readWholeArtworkProjection(
  slug: string,
  instant: string,
  catalogBinding?: RwaAsset["binding"],
): Promise<ProjectionReadResponse> {
  try {
    const config = configuration(slug, instant, catalogBinding);
    const path = `v1/oracle/projection/${config.tokenId}`;
    const read = (tail = "") =>
      readJson(new URL(`${path}${tail}`, config.base));
    function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
      const result = schema.safeParse(value);
      if (!result.success) fail("PROJECTION_SOURCE_MALFORMED");
      return result.data;
    }
    const identity = parse(identitySchema, await read());
    const matches = (value: z.infer<typeof projectionSourceSchema>) =>
      value.chainId === config.chainId &&
      value.contract.toLowerCase() === config.contract.toLowerCase() &&
      value.registerId.toLowerCase() ===
        identity.source.registerId.toLowerCase();
    if (
      identity.tokenId !== config.tokenId ||
      !matches(identity.source) ||
      identity.registerId.toLowerCase() !==
        identity.source.registerId.toLowerCase()
    )
      fail("PROJECTION_BINDING_MISMATCH");
    async function observe<T extends z.ZodType>(schema: T, tail: string) {
      try {
        const value = parse(schema, await read(tail));
        const bound = value as {
          tokenId: string;
          source: z.infer<typeof projectionSourceSchema>;
          instant?: string;
        };
        if (
          bound.tokenId !== config.tokenId ||
          !matches(bound.source) ||
          (bound.instant !== undefined && bound.instant !== instant)
        )
          fail("PROJECTION_BINDING_MISMATCH");
        return { ok: true as const, value };
      } catch (error) {
        return failure(error);
      }
    }
    const [entry, holder, finality, position] = await Promise.all([
      observe(entrySchema, `/entry/as-of/${instant}`),
      observe(holderSchema, `/holder/as-of/${instant}`),
      observe(finalitySchema, `/finality/as-of/${instant}`),
      observe(positionSchema, "/position"),
    ]);
    // Check only the entry's own normative interval. Do not derive temporal
    // finality from it: that remains the independent Oracle observation.
    if (entry.ok) {
      const value = entry.value.entry;
      const start = BigInt(value.effectiveAt),
        end = BigInt(value.supersededAt),
        at = BigInt(instant);
      if (
        value.version === "0" ||
        start > at ||
        (end !== 0n && (end <= start || at >= end))
      ) {
        return { ok: false, code: "PROJECTION_SOURCE_MALFORMED" };
      }
    }
    // A binding change is never shown as a partly verified artwork. Ordinary
    // unavailable/not-covered reads stay independent of successful observations.
    if (
      [entry, holder, finality, position].some(
        (result) => !result.ok && result.code === "PROJECTION_BINDING_MISMATCH",
      )
    )
      fail("PROJECTION_BINDING_MISMATCH");
    const after = parse(identitySchema, await read());
    if (
      after.tokenId !== config.tokenId ||
      !matches(after.source) ||
      after.registerId.toLowerCase() !== identity.registerId.toLowerCase()
    )
      fail("PROJECTION_BINDING_MISMATCH");
    return {
      ok: true,
      tokenId: config.tokenId,
      instant,
      source: identity.source,
      entryCount: after.entryCount,
      entry: entry.ok ? { ok: true, value: entry.value.entry } : entry,
      holder: holder.ok ? { ok: true, value: holder.value.holder } : holder,
      finality: finality.ok
        ? { ok: true, value: finality.value.final }
        : finality,
      position: position.ok
        ? { ok: true, value: position.value.tradeablePosition }
        : position,
      readAt: new Date().toISOString(),
    };
  } catch (error) {
    return failure(error);
  }
}
