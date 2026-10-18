import type { ReactNode } from "react";
/** TEST_ONLY connection-modal seam; account and signing hooks remain real Wagmi. */
export const ConnectButton = {
  Custom: ({
    children,
  }: {
    children: (value: {
      mounted: boolean;
      openConnectModal: () => void;
    }) => ReactNode;
  }) =>
    children({
      mounted: true,
      openConnectModal: () => window.charityFixture.connect?.(),
    }),
};
