import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createOracleObservation } from "./oracle-observation.mjs";

// Explicit opt-in: import real, pinned Oracle source; never copy it or use a fallback.
// Keys exist only in memory for synthetic Ed25519 fixtures. No live source or chain.
const checkout = process.env.ARTFI_ORACLE_TEST_CHECKOUT;
assert(
  checkout && path.isAbsolute(checkout),
  "ARTFI_ORACLE_TEST_CHECKOUT must name an existing absolute Oracle checkout",
);
const pins = {
  "src/sdk/verifier.js": "74faae7ca80f1fc09192bafb3bfe816fa5550b96",
  "src/domain/attestation-service.js":
    "8ccb59e0d4f6ce1019780632089d62b51d8b5a87",
  "src/domain/canonical-json.js": "7afc5df12a0d1da079a9b892cfa97f9677321fae",
  "src/domain/revocation-registry.js":
    "719077c7f7ca89563d86e1282384b31442122124",
  "src/adapters/resilient-source-adapter.js":
    "395b70a8ed64f27d8923f35d2bce8bad0559a292",
};
// Git blob identities rechecked unchanged on Oracle main
// f2ba4bc5fa6e88330a19c3f8684764e524917dd0 (through PR #41).
for (const [file, expected] of Object.entries(pins)) {
  const bytes = Buffer.from(
    (await readFile(path.join(checkout, file), "utf8")).replaceAll(
      "\r\n",
      "\n",
    ),
  );
  const actual = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assert.equal(
    actual,
    expected,
    `Oracle source differs from pinned handoff: ${file}`,
  );
}
const load = (file) => import(pathToFileURL(path.join(checkout, file)).href);
const { verifyOracleAttestation } = await load("src/sdk/verifier.js");
const { AttestationService } = await load("src/domain/attestation-service.js");
const { RevocationRegistry } = await load("src/domain/revocation-registry.js");
const { ResilientSourceAdapter } = await load(
  "src/adapters/resilient-source-adapter.js",
);

function fixture() {
  const now = new Date("2026-09-13T00:00:00Z");
  const subject = {
    assetId: "synthetic-asset",
    chainId: "560048",
    contract: "0x" + "ab".repeat(20),
    tokenId: "1",
    purpose: "transfer-eligibility",
  };
  const revocations = new RevocationRegistry();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const service = new AttestationService({
    signerSetId: "synthetic-signers",
    privateKey,
    publicKey,
    revocations,
    clock: () => now,
  });
  const attestation = service.issue({
    subject,
    factType: "TRANSFER_STATUS",
    factValue: true,
    sourceAuthority: "synthetic-registry",
    sourceRecordHash: "a".repeat(64),
    validForSeconds: 60,
    nonce: "synthetic-nonce",
  });
  const request = {
    execution: { chainId: subject.chainId },
    sale: { nft: subject.contract, tokenId: subject.tokenId },
  };
  const options = {
    mode: "TEST_ONLY_NO_REAL_VALUE",
    observe: async () => ({
      available: true,
      current: true,
      assetRestricted: false,
    }),
    resolveRequiredAttestation: async () => ({
      attestation,
      expectedSubject: subject,
    }),
    verifyOracleAttestation,
    attestationService: service,
    clock: () => now,
  };
  return { now, subject, service, revocations, attestation, request, options };
}

test("real Oracle Ed25519 SDK: valid, exact expiry, revoked and subject mismatch", async () => {
  const f = fixture();
  const run = createOracleObservation(f.options);
  const valid = await run(f.request);
  assert.equal(valid.groundingCurrent, true);
  assert.equal(valid.oracleAttestation.valid, true);
  assert.equal(
    valid.oracleAttestation.attestationId,
    f.attestation.envelope.attestationId,
  );
  assert.deepEqual(valid.oracleAttestation.expectedSubject, f.subject);
  const expired = await createOracleObservation({
    ...f.options,
    clock: () => new Date(f.now.getTime() + 60000),
  })(f.request);
  assert.equal(expired.groundingCurrent, false);
  assert.equal(expired.oracleAttestation.errorCode, "NOT_CURRENT");
  f.revocations.revoke({
    attestationId: f.attestation.envelope.attestationId,
    reasonHash: "b".repeat(64),
    revokedAt: f.now.toISOString(),
    authorityId: "synthetic-authority",
  });
  const revoked = await run(f.request);
  assert.equal(revoked.assetRestricted, true);
  assert.equal(revoked.oracleAttestation.errorCode, "REVOKED");
  assert.equal(
    revoked.oracleAttestation.attestationId,
    f.attestation.envelope.attestationId,
  );
  const other = fixture();
  const mismatch = await createOracleObservation({
    ...other.options,
    resolveRequiredAttestation: async () => ({
      attestation: other.attestation,
      expectedSubject: { ...other.subject, purpose: "wrong-purpose" },
    }),
  })(other.request);
  assert.equal(mismatch.groundingCurrent, false);
  assert.equal(mismatch.oracleAttestation.errorCode, "SUBJECT_MISMATCH");
});

test("real source adapter timeout/circuit-open never invokes verifier; reset recovers", async () => {
  const f = fixture();
  let now = 0,
    offline = true,
    verifierCalls = 0;
  const source = new ResilientSourceAdapter({
    sourceId: "synthetic-registry",
    capability: "asset.read",
    versions: ["v1"],
    timeoutMs: 10,
    failureThreshold: 1,
    resetMs: 100,
    clock: () => now,
    transport: {
      fetch: async () =>
        offline
          ? new Promise(() => {})
          : { attestation: f.attestation, expectedSubject: f.subject },
    },
  });
  const run = createOracleObservation({
    ...f.options,
    resolveRequiredAttestation: () =>
      source.fetch({ version: "v1", recordRef: "synthetic-asset" }),
    verifyOracleAttestation: (...args) => {
      verifierCalls++;
      return verifyOracleAttestation(...args);
    },
  });
  for (const code of ["SOURCE_TIMEOUT", "SOURCE_CIRCUIT_OPEN"]) {
    const result = await run(f.request);
    assert.equal(result.available, false);
    assert.equal(result.current, false);
    assert.equal(result.oracleAttestation.errorCode, code);
    assert.equal(result.oracleAttestation.attestationId, undefined);
    assert.equal(verifierCalls, 0);
  }
  offline = false;
  now = 101;
  const recovered = await run(f.request);
  assert.equal(recovered.groundingCurrent, true);
  assert.equal(verifierCalls, 1);
});
