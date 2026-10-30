import type { DisclaimerComponent } from "@rainbow-me/rainbowkit";

import { XIONGAN_WALLET_DISCLOSURE } from "@/lib/xiongan-wallet";

import { XionganWalletLink } from "./xiongan-wallet-link";

/** A DApp link in the chooser, never a fabricated wagmi connector. */
export const XionganWalletDisclaimer: DisclaimerComponent = ({ Text }) => (
  <Text>
    <XionganWalletLink /> {XIONGAN_WALLET_DISCLOSURE}
  </Text>
);
