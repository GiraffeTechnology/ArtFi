import { describe, expect, it } from "vitest";
import { verify } from "node:crypto";
import { hexToBytes } from "viem";
import { sourceMintFixture } from "../test/rwa-source-fixture";
import {
  assertMintPreparation,
  assertSourceBoundMint,
  mintSourceContext,
  sourceContractEvidence,
  sourceEvidencePreimage,
} from "./rwa-source-evidence";
const intent = {
  chainId: 560048,
  registryAddress: "0x1000000000000000000000000000000000000001",
  recipient: "0x1000000000000000000000000000000000000010",
  requestId: `0x${"11".repeat(32)}` as const,
  metadataSha256: `0x${"22".repeat(32)}` as const,
  metadataUri: "https://objects.example.test/test.json",
};
describe("approved-source mint boundary", () => {
  it("matches a real ephemeral P-256 signature over the exact ABI preimage", () => {
    const fixture = sourceMintFixture(intent);
    const e = fixture.sourceEvidence;
    expect(
      verify(
        "sha256",
        hexToBytes(sourceEvidencePreimage(e)),
        { key: fixture.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(e.signatureR.slice(2) + e.signatureS.slice(2), "hex"),
      ),
    ).toBe(true);
    expect(() =>
      assertSourceBoundMint({ ...intent, ...fixture }),
    ).not.toThrow();
  });
  it("never turns an unsigned metadata preparation into executable mint authority", () => {
    const preparation = {
      ...intent,
      contextHash: mintSourceContext(intent),
      executable: false,
      status: "awaiting-approved-source-evidence",
    };
    expect(() =>
      assertMintPreparation(
        preparation,
        intent.recipient,
        intent.registryAddress,
      ),
    ).not.toThrow();
    expect(() => assertSourceBoundMint(intent)).toThrow(
      /approved-source evidence/,
    );
    expect(() =>
      assertMintPreparation(
        { ...preparation, executable: true },
        intent.recipient,
        intent.registryAddress,
      ),
    ).toThrow();
  });
  it("binds source identity, underlying asset, rights, model, environment and validity", () => {
    const fixture = sourceMintFixture(intent);
    for (const patch of [
      { recipient: "0x1000000000000000000000000000000000000020" },
      { registryAddress: "0x1000000000000000000000000000000000000002" },
      { metadataUri: "https://objects.example.test/changed" },
      { metadataSha256: `0x${"33".repeat(32)}` as const },
    ])
      expect(() =>
        assertSourceBoundMint({ ...intent, ...fixture, ...patch }),
      ).toThrow();
    const evidence = {
      ...fixture.sourceEvidence,
      rights: "Changed rights asserted without source approval",
    };
    expect(() =>
      assertSourceBoundMint({
        ...intent,
        ...fixture,
        sourceEvidence: evidence,
      }),
    ).toThrow(/contract evidence/);
    expect(() =>
      assertSourceBoundMint(
        { ...intent, ...fixture },
        fixture.sourceEvidence.validUntil * 1000,
      ),
    ).toThrow();
    expect(() =>
      assertSourceBoundMint(
        { ...intent, ...fixture },
        (fixture.sourceEvidence.validFrom - 1) * 1000,
      ),
    ).toThrow();
    const whole = { ...fixture.sourceEvidence, section: "whole" as const };
    expect(() =>
      assertSourceBoundMint({
        ...intent,
        sourceEvidence: whole,
        contractEvidence: sourceContractEvidence(whole),
      }),
    ).toThrow();
  });
  it("retains exact claims and canonical escaped characters for Go/Solidity correspondence", () => {
    const { sourceEvidence: e } = sourceMintFixture(intent);
    e.rights = "TEST_ONLY <custody> & receipt; no real rights.\u2028";
    const c = sourceContractEvidence(e);
    expect(c.claimHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sourceEvidencePreimage(e).length).toBe(2 + 11 * 64);
  });
});
