import type { ComponentProps } from "react";

import { XIONGAN_WALLET_URL } from "@/lib/xiongan-wallet";

export function XionganWalletLink({
  className,
  onClick,
}: Pick<ComponentProps<"a">, "className" | "onClick">) {
  return (
    <a
      aria-label="Open Xiongan Wallet (new tab)"
      className={["xiongan-wallet-link", className].filter(Boolean).join(" ")}
      href={XIONGAN_WALLET_URL}
      onClick={onClick}
      rel="noopener noreferrer"
      target="_blank"
    >
      Open Xiongan Wallet <span aria-hidden="true">↗</span>
    </a>
  );
}
