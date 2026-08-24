import { describe, expect, it } from "vitest";

import { externalMarketChain, supportedChain, wagmiConfig } from "./wagmi";

describe("wallet network policy", () => {
  it("keeps writes on Base Sepolia while reserving Base for gated external fulfillment", () => {
    expect(supportedChain.id).toBe(84532);
    expect(externalMarketChain.id).toBe(8453);
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([84532, 8453]);
  });
});
