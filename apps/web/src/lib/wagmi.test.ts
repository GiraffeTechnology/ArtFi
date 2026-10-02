import { describe, expect, it } from "vitest";

import { externalMarketChain, supportedChain } from "./wagmi";
import { wagmiConfig } from "./wallet-config";

describe("wallet network policy", () => {
  it("keeps writes on Hoodi while reserving Ethereum for gated external fulfillment", () => {
    expect(supportedChain.id).toBe(560048);
    expect(externalMarketChain.id).toBe(1);
    expect(wagmiConfig.chains.map((chain) => chain.id)).toEqual([560048, 1]);
    const browserWallet = wagmiConfig.connectors.find(
      (connector) => connector.id === "injected",
    );
    expect(browserWallet).toBeDefined();
    expect(browserWallet).toMatchObject({
      rkDetails: { isRainbowKitConnector: true, name: "Browser Wallet" },
    });
    expect(
      wagmiConfig.connectors.some(
        (connector) => connector.id === "walletConnect",
      ),
    ).toBe(false);
  });
});
