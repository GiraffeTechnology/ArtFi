"use client";

import { useState } from "react";
import type { Address } from "viem";

type NFTWalletImportProps = {
  collectionAddress: Address;
  quantity?: bigint;
  standard: "ERC-721" | "ERC-1155";
  tokenId: string;
};

export function NFTWalletImport({
  collectionAddress,
  quantity = 1n,
  standard,
  tokenId,
}: NFTWalletImportProps) {
  const [copyStatus, setCopyStatus] = useState("");
  const importDetails = [
    "Network: Hoodi",
    `Standard: ${standard}`,
    `Contract: ${collectionAddress}`,
    `Token ID: ${tokenId}`,
    `Quantity: ${quantity.toString()}`,
  ].join("\n");

  async function copyImportDetails() {
    try {
      await navigator.clipboard.writeText(importDetails);
      setCopyStatus(
        "Import details copied. Open the wallet NFT screen and choose Import NFT.",
      );
    } catch {
      setCopyStatus(
        "Clipboard access was unavailable. Copy the contract and Token ID shown below.",
      );
    }
  }

  return (
    <section className="nft-wallet-import" aria-label="Add NFT to wallet">
      <div>
        <p className="approved-eyebrow">Wallet display</p>
        <h3>Add this NFT to your wallet</h3>
        <p>
          Import changes wallet display only. It does not transfer the NFT,
          approve an operator or grant DAO rights.
        </p>
      </div>
      <dl>
        <div>
          <dt>Standard</dt>
          <dd>{standard}</dd>
        </div>
        <div>
          <dt>Contract</dt>
          <dd data-no-translate>{collectionAddress}</dd>
        </div>
        <div>
          <dt>Token ID</dt>
          <dd data-no-translate>{tokenId}</dd>
        </div>
        <div>
          <dt>Quantity</dt>
          <dd data-no-translate>{quantity.toString()}</dd>
        </div>
      </dl>
      <div className="nft-wallet-import__actions">
        <button className="secondary" type="button" onClick={copyImportDetails}>
          Copy wallet import details
        </button>
        <a
          className="text-link"
          href={`https://hoodi.etherscan.io/token/${collectionAddress}`}
          target="_blank"
          rel="noreferrer"
        >
          Inspect token contract on Etherscan ↗
        </a>
        <a
          className="text-link"
          href="https://support.metamask.io/manage-crypto/nfts/nft-tokens-in-your-metamask-wallet/"
          target="_blank"
          rel="noreferrer"
        >
          Wallet import guide ↗
        </a>
      </div>
      {copyStatus ? (
        <p className="nft-wallet-import__status">{copyStatus}</p>
      ) : null}
    </section>
  );
}
