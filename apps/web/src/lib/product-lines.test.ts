import { describe, expect, it } from "vitest";

import {
  productLines,
  productNavigation,
  toolNavigation,
} from "./product-lines";

describe("three product entry points", () => {
  it("keeps distinct NFT, whole RWA and fractional / DAO workflows", () => {
    expect(productLines.map(({ href }) => href)).toEqual([
      "/nft",
      "/rwa",
      "/market/fractionals",
    ]);
    expect(productNavigation.slice(1).map(([, href]) => href)).toEqual(
      productLines.map(({ href }) => href),
    );
  });

  it("keeps the user-defined product rights separate", () => {
    expect(productLines[0].detail).toContain(
      "without real-world asset backing",
    );
    expect(productLines[0].detail).toContain("CCHS");
    expect(productLines[0].detail).toContain("OpenSea");
    expect(productLines[0].detail).toContain("independent capability");
    expect(productLines[1].detail).toContain(
      "pickup voucher or warehouse receipt",
    );
    expect(productLines[1].detail).toContain("ERC-8415");
    expect(productLines[2].detail).toContain("original ArtFi workflow");
    expect(productLines[2].detail).toContain("DAO governance");
  });

  it("preserves the existing shared entry points", () => {
    expect(toolNavigation.map(([, href]) => href)).toEqual([
      "/market/rwa",
      "/market/activity",
      "/charity",
      "/create/rwa",
      "/portfolio",
      "/dao",
      "/projects",
      "/operations",
    ]);
  });
});
