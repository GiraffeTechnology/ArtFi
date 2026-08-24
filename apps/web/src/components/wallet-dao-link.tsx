"use client";

import Link from "next/link";
import { useAccount, useChainId } from "wagmi";

import { supportedChain } from "@/lib/wagmi";

import { WalletButton } from "./wallet-button";

export function WalletDaoLink() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const correctChain = chainId === supportedChain.id;

  return (
    <section className="wallet-dao-link" aria-label="Wallet and DAO connection">
      <div>
        <p className="approved-eyebrow">Wallet → DAO</p>
        <h2>Link the holder wallet to its asset DAO.</h2>
        <p>
          DAO membership requires three independent checks: wallet control,
          continuing ERC-721 custody in the corresponding Vault, and a positive
          RWA share-token balance. Displaying an NFT in a wallet is not enough.
        </p>
      </div>
      <ol>
        <li className={isConnected ? "is-complete" : ""}>
          <span>01</span>
          <strong>Connect holder wallet</strong>
          <small>{isConnected ? address : "No wallet connected"}</small>
        </li>
        <li className={correctChain ? "is-complete" : ""}>
          <span>02</span>
          <strong>Use Base Sepolia</strong>
          <small>
            {correctChain ? "Network ready" : "Network switch required"}
          </small>
        </li>
        <li>
          <span>03</span>
          <strong>Verify RWA rights</strong>
          <small>One nonce signature, then on-chain membership checks</small>
        </li>
      </ol>
      <div className="wallet-dao-link__actions">
        {!isConnected ? <WalletButton /> : null}
        <Link className="external-button" href="/dao">
          Open DAO verification
        </Link>
      </div>
    </section>
  );
}
