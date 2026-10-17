import "server-only";

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export const testNFTMetadataDescription =
  "TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT. Task-generated isolated technical input. No real warehouse, custody, institutional evidence, physical title, donation or production rights are asserted.";
export const testNFTMetadataNames = [
  "Simulated warehouse record - TESTNET",
  "Digitally native artwork - TESTNET",
] as const;

const hashPattern = /^[0-9a-f]{64}$/;
const maxMetadataBytes = 8_192;
const maxManifestBytes = 16_384;
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
};

export type TestNFTMetadataConfig = {
  environment?: string;
  chainId?: string;
  manifestPath?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function nonzeroHash(value: unknown): value is string {
  return (
    typeof value === "string" && hashPattern.test(value) && !/^0+$/.test(value)
  );
}

/** Fixed ASCII artifact profile rejects duplicate keys, alternative encodings and hidden fields. */
function parseCanonicalJSON(bytes: Buffer): unknown {
  if (!bytes.every((byte) => byte === 10 || (byte >= 32 && byte <= 126))) {
    throw new Error("invalid artifact encoding");
  }
  const text = bytes.toString("utf8");
  const value: unknown = JSON.parse(text);
  if (JSON.stringify(value, null, 2) + "\n" !== text) {
    throw new Error("noncanonical artifact");
  }
  return value;
}

/** Reads at most limit+1 bytes, even if a file grows after its first stat. */
async function readBoundedRegularFile(path: string, limit: number) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(limit)) {
      throw new Error("invalid artifact size or type");
    }
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        used,
        buffer.length - used,
        used,
      );
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      used > limit ||
      BigInt(used) !== after.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ino !== after.ino ||
      before.dev !== after.dev
    )
      throw new Error("artifact changed during read");
    return buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
}

function manifestHashes(value: unknown): string[] {
  if (
    !record(value) ||
    !exactKeys(value, ["schema", "chainId", "hashes"]) ||
    value.schema !== "artfi-test-nft-metadata/1" ||
    value.chainId !== 560048 ||
    !Array.isArray(value.hashes) ||
    value.hashes.length < 1 ||
    value.hashes.length > 100 ||
    !value.hashes.every(nonzeroHash) ||
    new Set(value.hashes).size !== value.hashes.length
  )
    throw new Error("invalid manifest");
  return value.hashes;
}

function validatePublicTestMetadata(value: unknown) {
  if (
    !record(value) ||
    !exactKeys(value, ["name", "description", "properties"])
  ) {
    throw new Error("invalid metadata envelope");
  }
  const p = value.properties;
  if (
    !record(p) ||
    !exactKeys(p, [
      "testOnly",
      "chainId",
      "assetKind",
      "sourceSha256",
      "realWorldValue",
      "legalTitle",
      "institutionalSourceEvidence",
    ]) ||
    p.testOnly !== true ||
    p.chainId !== 560048 ||
    (p.assetKind !== 0 && p.assetKind !== 1) ||
    !nonzeroHash(p.sourceSha256) ||
    p.realWorldValue !== false ||
    p.legalTitle !== false ||
    p.institutionalSourceEvidence !== false ||
    value.name !== testNFTMetadataNames[p.assetKind] ||
    value.description !== testNFTMetadataDescription
  )
    throw new Error("invalid test metadata");
}

function refusal(status: 404 | 503) {
  return new Response(
    JSON.stringify({
      detail:
        status === 404
          ? "Unknown test metadata."
          : "Test metadata is unavailable.",
    }),
    { status, headers },
  );
}

/** Public TEST_ONLY JSON only; this function supplies no grant, source proof, preview or wallet access. */
export async function serveTestNFTMetadata(
  sha256: string,
  config: TestNFTMetadataConfig,
): Promise<Response> {
  if (
    config.environment !== "test" ||
    config.chainId !== "560048" ||
    !nonzeroHash(sha256)
  ) {
    return refusal(404);
  }
  const manifestPath = config.manifestPath;
  if (!manifestPath || !isAbsolute(manifestPath)) return refusal(503);
  try {
    const directory = await realpath(dirname(manifestPath));
    const manifest = await readBoundedRegularFile(
      join(directory, basename(manifestPath)),
      maxManifestBytes,
    );
    const hashes = manifestHashes(parseCanonicalJSON(manifest));
    if (!hashes.includes(sha256)) return refusal(404);
    const bytes = await readBoundedRegularFile(
      join(directory, `${sha256}.json`),
      maxMetadataBytes,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      return refusal(503);
    validatePublicTestMetadata(parseCanonicalJSON(bytes));
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { ...headers, "Content-Length": String(bytes.length) },
    });
  } catch {
    // Never return storage paths, raw file content, parser exceptions or configuration values.
    return refusal(503);
  }
}
