import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WholeArtworkListing } from "./whole-artwork-listing";
const fixture = vi.hoisted(() => ({
  account: "0x1000000000000000000000000000000000000002",
  owner: "0x1000000000000000000000000000000000000002",
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: fixture.account,
    chainId: 560048,
    isConnected: true,
  }),
  usePublicClient: () => ({}),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useReadContract: ({ functionName }: { functionName: string }) => ({
    data:
      functionName === "ownerOf"
        ? fixture.owner
        : functionName === "sellerEpoch"
          ? 0n
          : false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./user-session-provider", () => ({
  useUserSession: () => ({ authenticated: true, revision: 1 }),
}));
vi.mock("./native-order-panel", () => ({ NativeOrderPanel: () => null }));
vi.mock("@/lib/use-market-transactions", () => ({
  useMarketTransactions: () => ({
    pending: undefined,
    begin: vi.fn(),
    reconcile: vi.fn(),
    captureReadContext: vi.fn(),
  }),
}));
function render(registryBacked: boolean) {
  return renderToStaticMarkup(
    createElement(WholeArtworkListing, {
      collection: fixture.owner,
      tokenId: "1",
      marketAddress: "0x1000000000000000000000000000000000000001",
      registryBacked,
    }),
  );
}
function button(html: string, text: string) {
  const found = html.match(new RegExp(`<button\\b[^>]*>${text}</button>`));
  expect(found, text).not.toBeNull();
  return found![0];
}
describe("registry receipt legacy action boundary", () => {
  it("discloses registration integration without disabling an existing withdrawal", () => {
    const html = render(true);
    expect(html).toContain("Registration settlement is not integrated");
    expect(button(html, "Approve the market")).toContain("disabled");
    expect(button(html, "Sign the sale terms")).toContain("disabled");
    expect(button(html, "Withdraw every authorization")).not.toContain(
      "disabled",
    );
    expect(html).toContain("Chain token owner");
    expect(html).not.toContain("Chain token holder");
    expect(html).toContain("may differ");
  });
  it("preserves the non-registry direct-payment product's existing approval", () => {
    const html = render(false);
    expect(button(html, "Approve the market")).not.toContain("disabled");
    expect(html).not.toContain("Registration settlement is not integrated");
  });
});
