import { describe, expect, it } from "vitest";

import {
  decideHolderAsset,
  publicEditionView,
  resolveHolderAsset,
  watermarkedHolderClass,
} from "./charity-assets";

const masterDigest = "a".repeat(64);
const holderDigest = "b".repeat(64);

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    class: watermarkedHolderClass,
    tokenId: "1",
    sha256: holderDigest,
    masterSha256: masterDigest,
    contentType: "image/jpeg",
    byteLength: 4_194_304,
    objectKey: "charity/holder/1.jpg",
    ...overrides,
  };
}

describe("charity holder asset boundary", () => {
  it("delivers a well-formed watermarked holder descriptor", () => {
    const decision = decideHolderAsset(descriptor());
    expect(decision.ok).toBe(true);
    if (decision.ok)
      expect(decision.asset.objectKey).toBe("charity/holder/1.jpg");
  });

  it("refuses a master mislabelled as a holder file", () => {
    const decision = decideHolderAsset(descriptor({ class: "master" }));
    expect(decision).toEqual({ ok: false, refusal: "not-watermarked" });
  });

  it("refuses a descriptor with no class at all", () => {
    const withoutClass: Record<string, unknown> = descriptor();
    delete withoutClass.class;
    const decision = decideHolderAsset(withoutClass);
    expect(decision).toEqual({ ok: false, refusal: "not-watermarked" });
  });

  it("refuses a holder file whose digest equals the master digest", () => {
    // CH.11. A file claiming to be watermarked while hashing identically to the master is the
    // master, whatever it calls itself.
    const decision = decideHolderAsset(descriptor({ sha256: masterDigest }));
    expect(decision).toEqual({ ok: false, refusal: "master-digest-collision" });
  });

  it("refuses a digest collision regardless of hex casing", () => {
    const decision = decideHolderAsset(
      descriptor({ sha256: masterDigest.toUpperCase() }),
    );
    // Upper-case hex fails the strict digest shape before the comparison, and is still refused.
    expect(decision.ok).toBe(false);
  });

  it("refuses a descriptor carrying a preview URL", () => {
    const decision = decideHolderAsset(
      descriptor({ previewUrl: "https://example.invalid/preview.jpg" }),
    );
    expect(decision).toEqual({ ok: false, refusal: "preview-attached" });
  });

  it("refuses a malformed descriptor rather than guessing", () => {
    expect(decideHolderAsset(descriptor({ sha256: "short" })).ok).toBe(false);
    expect(decideHolderAsset(descriptor({ byteLength: 0 })).ok).toBe(false);
    expect(decideHolderAsset(descriptor({ objectKey: "" })).ok).toBe(false);
    expect(decideHolderAsset(descriptor({ contentType: "text/html" })).ok).toBe(
      false,
    );
    expect(decideHolderAsset(undefined)).toEqual({
      ok: false,
      refusal: "unknown-edition",
    });
  });

  it("refuses an unknown edition without a fallback object", async () => {
    const decision = await resolveHolderAsset("9", async () => undefined);
    expect(decision).toEqual({ ok: false, refusal: "unknown-edition" });
  });

  it("refuses a descriptor that answers for a different edition", async () => {
    const decision = await resolveHolderAsset("2", async () =>
      descriptor({ tokenId: "1" }),
    );
    expect(decision).toEqual({ ok: false, refusal: "unknown-edition" });
  });

  it("resolves the matching edition", async () => {
    const decision = await resolveHolderAsset("1", async () => descriptor());
    expect(decision.ok).toBe(true);
  });
});

describe("public edition view", () => {
  it("has nowhere to put a preview or a master", () => {
    const view = publicEditionView("1");
    expect(view.artworkPreview).toBe("not-provided");
    expect(JSON.stringify(view)).not.toContain("master");
    expect(JSON.stringify(view)).not.toContain("preview.jpg");
    expect(view.editionsPerArtwork).toBe(100);
    expect(view.primaryPriceWei).toBe("10000000000000000");
  });
});
