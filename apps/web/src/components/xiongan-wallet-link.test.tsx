import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  XIONGAN_WALLET_DISCLOSURE,
  XIONGAN_WALLET_URL,
} from "@/lib/xiongan-wallet";

import { XionganWalletLink } from "./xiongan-wallet-link";

describe("Xiongan DApp entry", () => {
  it("uses the canonical public HTTPS page without a private port or payload", () => {
    const url = new URL(XIONGAN_WALLET_URL);
    expect(url.href).toBe("https://xiongan.8415wallet.com/web/index.html");
    expect(url.port).toBe("");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
  });

  it("is an isolated external link with an explicit new-tab label", () => {
    const html = renderToStaticMarkup(createElement(XionganWalletLink));
    expect(html).toContain(`href="${XIONGAN_WALLET_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Open Xiongan Wallet");
    expect(html).toContain("(new tab)");
    expect(html).not.toContain("<button");
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
