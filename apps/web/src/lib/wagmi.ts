import { createConfig, http } from "wagmi";
import { hoodi, mainnet } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const supportedChain = hoodi;
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
