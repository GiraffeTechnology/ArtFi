import { describe, expect, it } from "vitest";

import { externalMarketChain, supportedChain, wagmiConfig } from "./wagmi";

describe("wallet network policy", () => {
  it("keeps writes on Hoodi while reserving Ethereum for gated external fulfillment", () => {
    expect(supportedChain.id).toBe(560048);
    expect(externalMarketChain.id).toBe(1);
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([560048, 1]);
  });
});
