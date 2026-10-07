import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { XIONGAN_WALLET_DISCLOSURE } from "@/lib/xiongan-wallet";
import type { XionganWalletState } from "@/lib/xiongan-wallet-config";
import { XionganWalletContext } from "./xiongan-wallet-provider";
import { XionganWalletLink } from "./xiongan-wallet-link";

function render(state: XionganWalletState) {
  return renderToStaticMarkup(
    createElement(
      XionganWalletContext.Provider,
      {
        value: { state, refresh: () => {} },
      },
      createElement(XionganWalletLink),
    ),
  );
}

describe("Xiongan DApp entry", () => {
  it.each([
    "https://wallet-a.example:18443/wallet/index.html",
    "https://wallet-b.example:29444/tenant/xiongan/",
  ])("uses the deployment's complete URL: %s", (url) => {
    const html = render({ ok: true, url });
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open Xiongan Wallet");
    expect(html).toContain("(new tab)");
    expect(html).not.toContain("<button");
  });
  it.each([
    "NOT_CONFIGURED",
    "INVALID_CONFIG",
    "UNAVAILABLE",
    "LOADING",
  ] as const)("never renders a destination when %s", (code) => {
    const html = render({ ok: false, code });
    expect(html).not.toContain("href=");
    expect(html).not.toContain("xiongan.8415wallet.com");
    expect(html).toContain('role="status"');
    if (code !== "LOADING")
      expect(html).toContain("Retry wallet configuration");
  });
  it("does not present navigation as wallet connection", () => {
    expect(XIONGAN_WALLET_DISCLOSURE).toContain(
      "Opening it does not connect a wallet to ArtFi",
    );
    expect(XIONGAN_WALLET_DISCLOSURE).toContain(
      "Connect your browser wallet separately in each app",
    );
  });
});
