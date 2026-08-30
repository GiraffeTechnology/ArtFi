import { createConfig, http } from "wagmi";
import { hoodi, mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/** Write-test chain. Test only — it says nothing about the production target. */
export const supportedChain = hoodi;

/**
 * Read-only source for the external-marketplace mirror. Not a deployment
 * target: the production chain is an open decision, so nothing here may be
 * cited as naming one.
 */
export const externalMarketChain = mainnet;

export const wagmiConfig = createConfig({
  chains: [hoodi, mainnet],
  connectors: [injected()],
  transports: {
    [hoodi.id]: http(process.env.NEXT_PUBLIC_HOODI_RPC_URL || undefined),
    [mainnet.id]: http(process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || undefined),
  },
  ssr: true,
});
