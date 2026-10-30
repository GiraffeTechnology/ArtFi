import { hoodi, mainnet } from "wagmi/chains";

/** Write-test chain. Test only; this does not select the production target. */
export const supportedChain = hoodi;
/** Read-only source for attributed external-marketplace records. */
export const externalMarketChain = mainnet;
