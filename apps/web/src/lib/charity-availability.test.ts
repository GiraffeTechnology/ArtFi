import { describe, expect, it } from "vitest";

import {
  editionAvailability,
  type CharityEdition,
} from "@/components/charity-edition-catalog";

/**
 * CH.3 in the one place a user reads it.
 *
 * An empty distribution wallet looks like a sellout and is not one: CH.3 records a sellout only
 * after the sale evidence is externally reconciled, and `recordSellout` reverts until then. A card
 * that rounded the empty wallet up to "sold out" would publish a state the chain has not recorded,
 * which is why this rule is a pure function with its own tests rather than a conditional buried in
 * the markup.
 */

function edition(overrides: Partial<CharityEdition> = {}): CharityEdition {
  return {
    tokenId: "1",
    artworkId: `0x${"11".repeat(32)}`,
    distributionWallet: "0x00000000000000000000000000000000000000a1",
    mintedUnits: 100n,
    distributorUnits: 100n,
    soldOutAt: 0,
    physicalDonationRecordedAt: 0,
    ...overrides,
  };
}

describe("editionAvailability", () => {
  it("reports what the distribution wallet still holds", () => {
    expect(editionAvailability(edition({ distributorUnits: 63n }))).toBe(
      "63 of 100 held by the distribution wallet",
    );
  });

  it("does not call an empty wallet a sellout", () => {
    const text = editionAvailability(edition({ distributorUnits: 0n }));
    expect(text).toContain("sellout not yet recorded");
    expect(text).not.toMatch(/^Sellout recorded$/);
  });

  it("reports a sellout only once the chain records one", () => {
    expect(
      editionAvailability(
        edition({ distributorUnits: 0n, soldOutAt: 1_760_000_000 }),
      ),
    ).toBe("Sellout recorded");
  });

  it("trusts the recorded sellout over the balance if they disagree", () => {
    // The chain's record is the statement; a stale balance read does not overturn it.
    expect(
      editionAvailability(
        edition({ distributorUnits: 4n, soldOutAt: 1_760_000_000 }),
      ),
    ).toBe("Sellout recorded");
  });
});
