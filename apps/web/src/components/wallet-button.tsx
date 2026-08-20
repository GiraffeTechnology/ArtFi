"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        mounted,
        openAccountModal,
        openChainModal,
        openConnectModal,
      }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        if (!connected) {
          return (
            <button
              className="wallet-button"
              onClick={openConnectModal}
              type="button"
            >
              Connect wallet
            </button>
          );
        }

        if (chain.unsupported) {
          return (
            <button
              className="wallet-button wallet-button--warning"
              onClick={openChainModal}
              type="button"
            >
              Switch to Sepolia
            </button>
          );
        }

        return (
          <button
            className="wallet-button wallet-button--connected"
            onClick={openAccountModal}
            type="button"
          >
            <span className="wallet-dot" aria-hidden="true" />
            <span data-no-translate>{account.displayName}</span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
