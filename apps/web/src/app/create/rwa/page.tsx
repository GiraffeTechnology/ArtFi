import type { Metadata } from "next";

import { MintedNFTCatalog } from "@/components/minted-nft-catalog";
import { NFTMintConsole } from "@/components/nft-mint-console";

export const metadata: Metadata = { title: "NFT control" };

export default function CreateRwaPage() {
  return (
    <main className="page-shell page-main">
      <header className="page-intro page-intro--compact">
        <p className="eyebrow">NFT control · authorized testnet write</p>
        <h1>Mint, verify, and route the token.</h1>
        <p>
          Control ERC-721 unique assets and ERC-1155 fixed editions from one
          review surface. Every write is confirmed by an authorized external
          wallet on Sepolia. The application never receives a private key.
        </p>
      </header>
      <NFTMintConsole />
      <MintedNFTCatalog />
    </main>
  );
}
