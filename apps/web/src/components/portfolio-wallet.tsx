"use client";

import { useAccount, useBalance } from "wagmi";

import { supportedChain } from "@/lib/wagmi";
import { portfolioSessionKey } from "@/lib/portfolio-session";

import { WalletButton } from "./wallet-button";
import { useUserSession } from "./user-session-provider";

export function PortfolioWallet() {
  const wallet = useAccount();
  const auth = useUserSession();
  const sessionKey = portfolioSessionKey(auth, wallet);
  if (!sessionKey || !wallet.address) {
    return (
      <section
        className="wallet-panel"
        aria-live="polite"
        data-testid="portfolio-wallet-gate"
      >
        <div>
          <p className="eyebrow">Wallet context</p>
          <h2>Sign in to view wallet assets</h2>
          <p>
            Connecting a wallet is not sign-in. Asset balances remain hidden
            until the connected wallet has an authenticated session.
          </p>
          {!wallet.isConnected && <WalletButton />}
        </div>
      </section>
    );
  }
  return (
    <AuthenticatedPortfolioWallet
      key={sessionKey}
      address={wallet.address}
      chainId={wallet.chainId}
      sessionKey={sessionKey}
    />
  );
}

function AuthenticatedPortfolioWallet({
  address,
  chainId,
  sessionKey,
}: {
  address: `0x${string}`;
  chainId?: number;
  sessionKey: string;
}) {
  const balance = useBalance({
    address,
    chainId: supportedChain.id,
    scopeKey: sessionKey,
    query: { enabled: chainId === supportedChain.id, gcTime: 0 },
  });
  const isSupported = chainId === supportedChain.id;

  return (
    <section className="wallet-panel" aria-live="polite">
      <div>
        <p className="eyebrow">Wallet context</p>
        <h2>Authenticated portfolio</h2>
      </div>
      <dl className="wallet-facts">
        <div>
          <dt>Network</dt>
          <dd>{isSupported ? "Hoodi" : "Unsupported — switch required"}</dd>
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
    </section>
  );
}
