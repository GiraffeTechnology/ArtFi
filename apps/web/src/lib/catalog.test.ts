import { describe, expect, it } from "vitest";

import { artworks, getArtwork, getProjectArtworks, projects } from "./catalog";

describe("catalog fixtures", () => {
  it("keeps every project reference resolvable", () => {
    for (const project of projects) {
      expect(getProjectArtworks(project)).toHaveLength(
        project.assetSlugs.length,
      );
    }
  });

  it("never exposes more fractions than the total supply", () => {
    expect(
      artworks.every(
        (artwork) => artwork.availableFractions <= artwork.totalFractions,
      ),
    ).toBe(true);
  });

  it("returns undefined for unknown artwork slugs", () => {
    expect(getArtwork("not-real")).toBeUndefined();
  });
});
