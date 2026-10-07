"use client";

import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http } from "wagmi";
import { externalMarketChain, supportedChain } from "./wagmi";

export const wagmiConfig = createConfig({
  chains: [supportedChain, externalMarketChain],
  // Register the injected provider with RainbowKit metadata. A bare wagmi injected()
  // connector is filtered out of the chooser unless the wallet also announces EIP-6963.
  // This list has no WalletConnect connector, so no project credential is used or created.
  connectors: connectorsForWallets(
    [{ groupName: "Browser wallets", wallets: [injectedWallet] }],
    { appName: "ArtFi", projectId: "" },
  ),
  transports: {
    [supportedChain.id]: http(
      process.env.NEXT_PUBLIC_HOODI_RPC_URL || undefined,
    ),
    [externalMarketChain.id]: http(
      process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || undefined,
    ),
  },
  ssr: true,
});
