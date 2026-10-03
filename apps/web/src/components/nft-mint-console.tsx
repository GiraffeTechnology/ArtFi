"use client";

import { useState } from "react";

import { CharityEditionCreateFlow } from "./charity-edition-create-flow";
import { RwaCreateFlow } from "./rwa-create-flow";

type Standard = "erc721" | "erc1155";

const standards = [
  {
    id: "erc721" as const,
    kicker: "Existing unique asset record",
    title: "ERC-721",
    detail:
      "One unique token per approved asset record. This existing mint contract does not implement ERC-8415 register projection. Eligible ERC-721 assets can later enter the reviewed Vault and corresponding DAO flow.",
  },
  {
    id: "erc1155" as const,
    kicker: "Fixed charity edition",
    title: "ERC-1155",
    detail:
      "One token ID per artwork with exactly 100 immutable units. This path does not itself create DAO rights or an ArtFi marketplace listing.",
  },
] as const;

export function NFTMintConsole({
  initialStandard = "erc721",
}: {
  initialStandard?: Standard;
}) {
  const [standard, setStandard] = useState<Standard>(initialStandard);

  return (
    <section
      className="nft-mint-console"
      aria-label="NFT standard mint controls"
    >
      <div
        className="nft-standard-selector"
        role="tablist"
        aria-label="NFT standard"
      >
        {standards.map((item) => {
          const selected = standard === item.id;
          return (
            <button
              aria-controls={`mint-panel-${item.id}`}
              aria-selected={selected}
              className={
                selected
                  ? "nft-standard-card nft-standard-card--active"
                  : "nft-standard-card"
              }
              id={`mint-tab-${item.id}`}
              key={item.id}
              onClick={() => setStandard(item.id)}
              role="tab"
              tabIndex={selected ? 0 : -1}
              type="button"
            >
              <span>{item.kicker}</span>
              <strong>{item.title}</strong>
              <small>{item.detail}</small>
            </button>
          );
        })}
      </div>

      <ol className="mint-stepper" aria-label="Mint and route lifecycle">
        <li>
          <span>1</span>Review record
        </li>
        <li>
          <span>2</span>Authorize wallet
        </li>
        <li>
          <span>3</span>Confirm token
        </li>
        <li>
          <span>4</span>Wallet / DAO
        </li>
      </ol>

      <div
        aria-labelledby={`mint-tab-${standard}`}
        id={`mint-panel-${standard}`}
        role="tabpanel"
      >
        {standard === "erc721" ? (
          <RwaCreateFlow />
        ) : (
          <CharityEditionCreateFlow />
        )}
      </div>
    </section>
  );
}
