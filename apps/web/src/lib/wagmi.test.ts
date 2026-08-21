import { describe, expect, it } from "vitest";

import { externalMarketChain, supportedChain, wagmiConfig } from "./wagmi";

describe("wallet network policy", () => {
  it("keeps writes on Sepolia while reserving Ethereum for gated external fulfillment", () => {
    expect(supportedChain.id).toBe(11155111);
    expect(externalMarketChain.id).toBe(1);
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([11155111, 1]);
  });
});
