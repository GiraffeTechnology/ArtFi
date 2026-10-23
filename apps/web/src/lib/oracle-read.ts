import type { RwaAsset } from "./rwa-catalog";
import { publicSetting } from "@/lib/public-runtime-config";
import "server-only";

import { isAddress } from "viem";
import { hoodi } from "viem/chains";
import { z } from "zod";
import {
  matchWholeReceiptSettlement,
  receiptJournalBindingSchema,
  receiptSettlementSchema,
} from "./whole-receipt-correspondence";

import { assetDeploymentBinding } from "./asset-binding";
import { getArtwork } from "./catalog";
import {
  oracleAssetReadSchema,
  oracleCertificateSchema,
  oracleTokenReadSchema,
  type OracleReadError,
  type OracleReadResponse,
} from "./oracle-read-model";

const maximumResponseBytes = 64 * 1024;
const requestTimeoutMs = 4_000;
const attestationFact = z.enum([
  "TRANSFER_STATUS", "ORACLE_STATUS", "CERTIFICATE_STATUS", "CERTIFICATE_VERSION",
  "WAREHOUSE_STATUS", "WAREHOUSE_ENCUMBRANCE_STATUS",
]);
const attestationValue = z.union([z.string().min(1).max(256), z.number().int().nonnegative().safe()]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const attestationPolicySchema = z.object({
  attestationId: z.string().uuid(),
  purpose: z.string().min(1).max(128),
  signerSetId: z.string().min(1).max(64),
  sourceAuthority: z.string().min(1).max(64),
  sourceRecordHash: sha256,
  factType: attestationFact,
  factValue: attestationValue,
}).strict();
export type WholeReceiptAttestationPolicy = z.infer<typeof attestationPolicySchema>;
const signedAttestationSchema = z.object({
  envelope: z.object({
    schemaVersion: z.literal("giraffe-attestation.v1"),
    attestationId: z.string().uuid(),
    subject: z.object({
      assetId: z.string().min(1).max(128), chainId: z.string().min(1).max(64),
      contract: z.string().min(1).max(128), tokenId: z.string().min(1).max(128),
      purpose: z.string().min(1).max(128),
    }).strict(),
    factType: attestationFact, factValue: attestationValue,
    sourceAuthority: z.string().min(1).max(64), sourceRecordHash: sha256,
    observedAt: z.string().datetime({offset:true}),
    validFrom: z.string().datetime({offset:true}),
    expiresAt: z.string().datetime({offset:true}),
    nonce: z.string().min(1).max(128), revocationRef: z.string().min(1).max(256).nullable(),
    signerSetId: z.string().min(1).max(64),
  }).strict(),
  envelopeHash: sha256,
  signature: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
class ReadError extends Error {
  constructor(readonly code: OracleReadError) {
    super(code);
  }
}

/** Existing Oracle GET + verification POST, not issuance or a financial proof.
 * Policy is fixed installation/source-record input, never browser-selected.
 * sourceRecordHash is the Oracle canonical hash of the exact authenticated
 * source record, NOT a certificate locator/hash or the settlement snapshot hash.
 * The deployment's approved verification service owns cryptographic/revocation
 * checks. No local replacement signer or signature format is introduced.
 */
export async function readWholeReceiptOracleAttestation(
  privateBinding: unknown,
  rawPolicy: WholeReceiptAttestationPolicy,
) {
  const binding = receiptJournalBindingSchema.parse(privateBinding);
  const policy = attestationPolicySchema.parse(rawPolicy);
  if (
    !/^(31337|560048)$/.test(binding.token.chainId) ||
    !isAddress(binding.token.contract) || /^0x0{40}$/i.test(binding.token.contract) ||
    !/^(0|[1-9][0-9]{0,77})$/.test(binding.token.tokenId) || BigInt(binding.token.tokenId) >= 2n ** 256n
  ) throw Error("ATTESTATION_READ_BINDING_INVALID");
  const expectedSubject = {
    assetId: binding.assetId, chainId: binding.token.chainId,
    contract: binding.token.contract, tokenId: binding.token.tokenId,
    purpose: policy.purpose,
  };
  const base = upstreamBase();
  const {attestation} = z.object({attestation:signedAttestationSchema,revoked:z.literal(false)}).strict().parse(
    await readJson(new URL(`v1/rwa/attestations/${policy.attestationId}`,base),"ASSET_NOT_FOUND"),
  );
  const e = attestation.envelope;
  if (
    e.attestationId !== policy.attestationId || e.signerSetId !== policy.signerSetId ||
    e.sourceAuthority !== policy.sourceAuthority || e.sourceRecordHash !== policy.sourceRecordHash ||
    e.factType !== policy.factType || e.factValue !== policy.factValue ||
    (Object.keys(expectedSubject) as (keyof typeof expectedSubject)[]).some(key=>e.subject[key]!==expectedSubject[key])
  ) throw Error("ATTESTATION_SOURCE_BINDING_MISMATCH");
  const current = () => {
    const observed = Date.parse(e.observedAt), from = Date.parse(e.validFrom), until = Date.parse(e.expiresAt);
    if (observed !== from || until <= from || until-from > 86400000 || Date.now() < from || Date.now() >= until)
      throw Error("ATTESTATION_NOT_CURRENT");
  };
  current();
  // Only the already-public envelope and exact asset subject leave this process;
  // private participants, task grants and external execution references do not.
  const result = z.object({valid:z.boolean(),errorCode:z.string().max(128).nullable()}).strict().parse(
    await readJson(new URL("v1/rwa/attestations/verify",base),"ASSET_NOT_FOUND", JSON.stringify({attestation,expectedSubject})),
  );
  if (result.valid !== true || result.errorCode !== null) throw Error("ATTESTATION_VERIFICATION_REJECTED");
  current();
  return {
    observationOnly: true as const,
    sourceAuthenticatedForPayment: false as const,
    registrationAuthorized: false as const,
    verification: { valid:true as const, attestationId:e.attestationId, envelopeHash:attestation.envelopeHash,
      subject:expectedSubject, signerSetId:e.signerSetId, sourceAuthority:e.sourceAuthority,
      sourceRecordHash:e.sourceRecordHash, factType:e.factType, factValue:e.factValue },
    readAt:new Date().toISOString(),
  };
}

/**
 * Public projection observation only. The caller must obtain the private binding
 * from its authenticated journal, not browser input. This does not authenticate
 * an Oracle financial proof or authorize escrow release. Never substitute the
 * latest certificate for the exact historical settlement certificate.
 */
export async function readWholeReceiptOracleObservation(
  privateBinding: unknown,
) {
  const binding = receiptJournalBindingSchema.parse(privateBinding);
  if (
    !/^[a-zA-Z0-9_-]{3,128}$/.test(binding.settlementId) ||
    !/^(31337|560048)$/.test(binding.token.chainId) ||
    !isAddress(binding.token.contract) ||
    /^0x0{40}$/i.test(binding.token.contract) ||
    !/^(0|[1-9][0-9]{0,77})$/.test(binding.token.tokenId) ||
    BigInt(binding.token.tokenId) >= 2n ** 256n
  )
    throw Error("SETTLEMENT_READ_BINDING_INVALID");
  const base = upstreamBase();
  const envelope = z
    .object({ settlement: receiptSettlementSchema })
    .strict()
    .parse(
      await readJson(
        new URL(`v1/rwa/settlements/${binding.settlementId}`, base),
        "ASSET_NOT_FOUND",
      ),
    );
  const settlement = envelope.settlement;
  let certificate: unknown;
  if (settlement.status === "FINALIZED") {
    const history = z
      .object({
        binding: z
          .object({
            assetId: z.string(),
            chainId: z.string(),
            contract: z.string(),
            tokenId: z.string(),
          })
          .passthrough(),
        history: z.array(oracleCertificateSchema).max(256),
      })
      .strict()
      .parse(
        await readJson(
          new URL(
            `v1/rwa/tokens/${binding.token.chainId}/${binding.token.contract}/${binding.token.tokenId}/certificate-history`,
            base,
          ),
          "TOKEN_NOT_FOUND",
        ),
      );
    if (
      history.binding.assetId !== binding.assetId ||
      history.binding.chainId !== binding.token.chainId ||
      history.binding.contract !== binding.token.contract ||
      history.binding.tokenId !== binding.token.tokenId
    )
      throw Error("SETTLEMENT_HISTORY_BINDING_MISMATCH");
    const matches = history.history.filter(
      (item) => item.certificateHash === settlement.newCertificateHash,
    );
    if (matches.length !== 1)
      throw Error("SETTLEMENT_HISTORY_AMBIGUOUS_OR_MISSING");
    certificate = matches[0];
  }
  return {
    observationOnly: true as const,
    sourceAuthenticatedForPayment: false as const,
    correspondence: matchWholeReceiptSettlement({
      journalBinding: binding,
      settlement,
      certificate,
    }),
    readAt: new Date().toISOString(),
  };
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
  verificationBody?: string,
) {
  if (verificationBody !== undefined && Buffer.byteLength(verificationBody,"utf8") > maximumResponseBytes)
    throw new ReadError("ORACLE_INVALID_RESPONSE");
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
          method: verificationBody === undefined ? "GET" : "POST",
          headers: { accept: "application/json", ...(verificationBody === undefined ? {} : {"content-type":"application/json"}) },
          ...(verificationBody === undefined ? {} : {body:verificationBody}),
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
  catalogBinding?: RwaAsset["binding"],
): Promise<OracleReadResponse> {
  try {
    if (!catalogBinding && !getArtwork(slug))
      throw new ReadError("UNKNOWN_ASSET");
    const contract =
      catalogBinding?.collectionAddress ??
      publicSetting(
        "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
      )?.trim();
    const binding = assetDeploymentBinding(
      slug,
      publicSetting("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG"),
      contract,
    );
    if (!catalogBinding && !binding.bound) {
      throw new ReadError(
        binding.boundElsewhere ? "BINDING_ELSEWHERE" : "BINDING_NOT_CONFIGURED",
      );
    }
    const tokenId =
      catalogBinding?.tokenId ??
      publicSetting("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID")?.trim();
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
    const chainId = String(catalogBinding?.chainId ?? hoodi.id);
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
      (catalogBinding?.assetId !== undefined &&
        token.binding.assetId !== catalogBinding.assetId) ||
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
