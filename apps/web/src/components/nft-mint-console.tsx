"use client";

import { useRef, useState } from "react";

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
  const [focused, setFocused] = useState<Standard>(initialStandard);
  const tabs = useRef<Record<Standard, HTMLButtonElement | null>>({
    erc721: null,
    erc1155: null,
  });

  return (
    <section
      className="nft-mint-console"
      aria-label="NFT standard mint controls"
    >
      <div
        className="nft-standard-selector"
        role="tablist"
        aria-label="NFT standard"
        aria-orientation="horizontal"
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
              ref={(node) => {
                tabs.current[item.id] = node;
              }}
              onFocus={() => setFocused(item.id)}
              onClick={() => {
                setFocused(item.id);
                setStandard(item.id);
              }}
              onKeyDown={(event) => {
                let next: Standard;
                if (event.key === "Home") next = standards[0].id;
                else if (event.key === "End")
                  next = standards[standards.length - 1].id;
                else if (
                  event.key === "ArrowRight" ||
                  event.key === "ArrowLeft"
                ) {
                  const index = standards.findIndex(
                    (entry) => entry.id === item.id,
                  );
                  const step = event.key === "ArrowRight" ? 1 : -1;
                  next =
                    standards[
                      (index + step + standards.length) % standards.length
                    ].id;
                } else return;
                event.preventDefault();
                // Manual activation keeps the current form until Enter, Space or click.
                tabs.current[next]?.focus();
              }}
              role="tab"
              tabIndex={focused === item.id ? 0 : -1}
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

      {standards.map((item) => (
        <div
          key={item.id}
          aria-labelledby={`mint-tab-${item.id}`}
          id={`mint-panel-${item.id}`}
          role="tabpanel"
          hidden={standard !== item.id}
          tabIndex={standard === item.id ? 0 : -1}
        >
          {standard === item.id ? (
            item.id === "erc721" ? (
              <RwaCreateFlow />
            ) : (
              <CharityEditionCreateFlow />
            )
          ) : null}
        </div>
      ))}
    </section>
  );
}
