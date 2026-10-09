import { describe, expect, it } from "vitest";
import { sourceMintFixture } from "../test/rwa-source-fixture";
import {
  parsePublicAsset,
  parseSourceEvidence,
  parsePendingPublication,
  rwaPublicationPath,
  rwaPublicationSchema,
} from "./rwa-publication";
const asset = {
  slug: "example-receipt",
  title: "Example artwork",
  artist: "Example artist",
  year: 2026,
  medium: "Example pigment",
  location: "Example custody",
  description: "Public descriptive record for an example artwork.",
  section: "whole",
  rights: "Example delivery receipt rights under the approved source record.",
  provenance: ["Approved source reference"],
  binding: {
    chainId: 560048,
    collectionAddress: "0x1000000000000000000000000000000000000002",
    tokenId: "1",
    underlyingAssetId: "urn:example:underlying",
  },
};
const mint = {
  chainId: 560048,
  registryAddress: "0x1000000000000000000000000000000000000001",
  recipient: "0x1000000000000000000000000000000000000010",
  requestId: `0x${"11".repeat(32)}` as const,
  metadataSha256: `0x${"22".repeat(32)}` as const,
  metadataUri: "https://objects.example.test/test.json",
};
describe("public source import schema", () => {
  it("accepts public records without invented image or administrator prerequisites", () => {
    const parsed = parsePublicAsset(JSON.stringify(asset));
    expect(parsed.imageUrl).toBe("");
    expect(parsed.binding.collectionAddress).toBe(
      asset.binding.collectionAddress,
    );
    expect(rwaPublicationPath(["drafts"], "POST")).toBe(
      "/v1/user/rwa/catalog-drafts",
    );
    expect(rwaPublicationPath(["assets", asset.slug], "PUT")).toBe(
      `/v1/user/rwa/assets/${asset.slug}`,
    );
  });
  it.each(["privateKey", "seed", "apiToken", "secret", "unknown"])(
    "rejects accidental %s at every imported scope before any network operation",
    (field) => {
      expect(() =>
        parsePublicAsset(
          JSON.stringify({ ...asset, [field]: "never transmit" }),
        ),
      ).toThrow(/unsupported/);
      expect(() =>
        parsePublicAsset(
          JSON.stringify({
            ...asset,
            binding: { ...asset.binding, [field]: "never transmit" },
          }),
        ),
      ).toThrow(/unsupported/);
      const e = sourceMintFixture(mint).sourceEvidence;
      expect(() =>
        parseSourceEvidence(
          JSON.stringify({ ...e, [field]: "never transmit" }),
        ),
      ).toThrow(/Private keys/);
      expect(() =>
        parseSourceEvidence(
          JSON.stringify({
            ...e,
            registryRecord: {
              reference: "source-record",
              version: "1",
              observedAt: e.validFrom,
              [field]: "never transmit",
            },
          }),
        ),
      ).toThrow(/Private keys/);
    },
  );
  it("accepts an ephemeral public source signature but binds rights and underlying model", () => {
    const e = sourceMintFixture(mint).sourceEvidence;
    const parsed = parseSourceEvidence(JSON.stringify(e));
    expect(parsed.signatureR).toBe(e.signatureR);
    expect(
      rwaPublicationSchema.safeParse({ revision: 0, asset, evidence: e })
        .success,
    ).toBe(false);
    const bound = {
      ...e,
      section: "whole" as const,
      rights: asset.rights,
      underlyingAssetId: asset.binding.underlyingAssetId,
    };
    const body = rwaPublicationSchema.parse({
      revision: 0,
      asset,
      evidence: bound,
    });
    const saved = JSON.stringify({ key: "unchanged-request-key", body });
    expect(parsePendingPublication(saved)?.body).toEqual(body);
    expect(
      parsePendingPublication(
        JSON.stringify({
          key: "unchanged-request-key",
          body,
          privateKey: "reject",
        }),
      ),
    ).toBeUndefined();
  });
  it("bounds malformed routes, JSON, token IDs and fractional associations", () => {
    for (const path of [
      ["admin"],
      ["assets", "../private"],
      ["assets", "id", "extra"],
    ])
      expect(rwaPublicationPath(path, "PUT")).toBeUndefined();
    expect(() => parsePublicAsset("not JSON")).toThrow();
    expect(() => parseSourceEvidence("{}")).toThrow();
    expect(() =>
      parsePublicAsset(JSON.stringify({ ...asset, section: "fractional" })),
    ).toThrow();
    expect(() =>
      parsePublicAsset(
        JSON.stringify({
          ...asset,
          binding: { ...asset.binding, tokenId: (1n << 256n).toString() },
        }),
      ),
    ).toThrow();
  });
});
