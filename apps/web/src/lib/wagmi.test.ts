import { describe, expect, it } from "vitest";

import { supportedChain, wagmiConfig } from "./wagmi";

describe("wallet network policy", () => {
  it("exposes Sepolia as the only supported chain", () => {
    expect(supportedChain.id).toBe(11155111);
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([11155111]);
  });
});
