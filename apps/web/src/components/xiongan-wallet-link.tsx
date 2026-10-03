"use client";

import type { ComponentProps } from "react";

import { walletConfigMessages } from "@/lib/xiongan-wallet-config";
import { useXionganWalletConfig } from "./xiongan-wallet-provider";

export function XionganWalletLink({
  className,
  onClick,
}: Pick<ComponentProps<"a">, "className" | "onClick">) {
  const { state, refresh } = useXionganWalletConfig();
  if (!state.ok)
    return (
      <span
        className={["xiongan-wallet-unavailable", className]
          .filter(Boolean)
          .join(" ")}
      >
        <span role="status">{walletConfigMessages[state.code]}</span>
        {state.code !== "LOADING" && (
          <button type="button" onClick={refresh}>
            Retry wallet configuration
          </button>
        )}
      </span>
    );
  return (
    <a
      aria-label="Open Xiongan Wallet (new tab)"
      className={["xiongan-wallet-link", className].filter(Boolean).join(" ")}
      href={state.url}
      onClick={onClick}
      rel="noopener noreferrer"
      target="_blank"
    >
      Open Xiongan Wallet <span aria-hidden="true">↗</span>
    </a>
  );
}
