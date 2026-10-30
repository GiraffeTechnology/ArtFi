// TEST_ONLY. Generate a fresh ephemeral P-256 key in test memory. This module is
// never imported by application code and never contains a real signing key.
import { generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { hexToBytes, sha256, stringToHex, type Hex } from "viem";
import {
  mintSourceContext,
  sourceContractEvidence,
  sourceEvidencePreimage,
  type RWASourceEvidence,
} from "../lib/rwa-source-evidence";
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export function sourceMintFixture(
  intent: Parameters<typeof mintSourceContext>[0],
  validity: Partial<Pick<RWASourceEvidence, "validFrom" | "validUntil">> = {},
) {
  return sourceEvidenceFixture(mintSourceContext(intent), validity);
}

export function sourceEvidenceFixture(
  contextHash: Hex,
  claim: Partial<
    Pick<
      RWASourceEvidence,
      "section" | "underlyingAssetId" | "rights" | "validFrom" | "validUntil"
    >
  > = {},
) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const evidence: RWASourceEvidence = {
    sourceId: "test-only-custody",
    sourceAssetId: `synthetic-${randomBytes(16).toString("hex")}`,
    underlyingAssetId: `urn:test-only:asset:${randomBytes(16).toString("hex")}`,
    evidenceId: `0x${randomBytes(32).toString("hex")}`,
    section: "fractional",
    mode: "TEST_ONLY",
    sourceReference: "https://source.example.test/TEST_ONLY",
    evidenceSha256: sha256(
      stringToHex("Synthetic document; no real entitlement"),
    ),
    rights:
      "TEST_ONLY source correspondence; no physical asset, legal or financial entitlement.",
    validFrom: Math.floor(Date.now() / 1000) - 3600,
    validUntil: Math.floor(Date.now() / 1000) + 86400,
    contextHash,
    signatureR: `0x${"01".repeat(32)}`,
    signatureS: `0x${"01".repeat(32)}`,
    ...claim,
  };
  function signed(value: RWASourceEvidence) {
    // crypto.sign hashes the fixed-width ABI preimage exactly once with SHA-256.
    const bytes = sign("sha256", hexToBytes(sourceEvidencePreimage(value)), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    });
    value.signatureR = `0x${bytes.subarray(0, 32).toString("hex")}`;
    let s = BigInt(`0x${bytes.subarray(32).toString("hex")}`);
    if (s > N / 2n) s = N - s;
    value.signatureS = `0x${s.toString(16).padStart(64, "0")}` as Hex;
    return {
      sourceEvidence: value,
      contractEvidence: sourceContractEvidence(value),
      publicKey,
    };
  }
  return {
    ...signed(evidence),
    renew() {
      return signed({
        ...evidence,
        evidenceId: `0x${randomBytes(32).toString("hex")}`,
        validFrom: Math.floor(Date.now() / 1000) - 60,
        validUntil: Math.floor(Date.now() / 1000) + 86400,
      });
    },
  };
}
