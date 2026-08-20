"use client";

import { useAccount, useBalance } from "wagmi";

import { supportedChain } from "@/lib/wagmi";

import { WalletButton } from "./wallet-button";

export function PortfolioWallet() {
  const { address, chainId, isConnected } = useAccount();
  const balance = useBalance({
    address,
    chainId: supportedChain.id,
    query: { enabled: Boolean(address) },
  });
  const isSupported = chainId === supportedChain.id;

  return (
    <section className="wallet-panel" aria-live="polite">
      <div>
        <p className="eyebrow">Wallet context</p>
        <h2>
          {isConnected
            ? "Connected portfolio preview"
            : "Connect to personalize this view"}
        </h2>
      </div>
      {!isConnected ? (
        <div className="wallet-panel__action">
          <p>
            ArtFi reads your public address only after you choose a wallet. No
            signature is requested.
          </p>
          <WalletButton />
        </div>
      ) : (
        <dl className="wallet-facts">
          <div>
            <dt>Network</dt>
            <dd>{isSupported ? "Sepolia" : "Unsupported — switch required"}</dd>
          </div>
          <div>
            <dt>Address</dt>
            <dd>{address}</dd>
          </div>
          <div>
            <dt>Test ETH</dt>
            <dd>
              {balance.data
                ? Number(balance.data.formatted).toFixed(4)
                : "Loading"}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
