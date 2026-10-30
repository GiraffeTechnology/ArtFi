import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ mounted: false, canOpen: false }));
vi.mock("@rainbow-me/rainbowkit", () => ({
  ConnectButton: {
    Custom: ({ children }: { children: (props: unknown) => unknown }) =>
      children({
        mounted: fixture.mounted,
        account: undefined,
        chain: undefined,
        openConnectModal: fixture.canOpen ? () => undefined : undefined,
      }),
  },
}));
import { WalletButton } from "./wallet-button";

describe("wallet connection readiness", () => {
  it("does not offer a dead connection click before hydration", () => {
    fixture.mounted = false;
    fixture.canOpen = false;
    expect(renderToStaticMarkup(createElement(WalletButton))).toContain(
      'disabled=""',
    );
  });
  it("waits for the modal callback even after mount", () => {
    fixture.mounted = true;
    fixture.canOpen = false;
    expect(renderToStaticMarkup(createElement(WalletButton))).toContain(
      'disabled=""',
    );
  });
  it("enables connection once the chooser is ready", () => {
    fixture.mounted = true;
    fixture.canOpen = true;
    expect(renderToStaticMarkup(createElement(WalletButton))).not.toContain(
      "disabled",
    );
  });
});
