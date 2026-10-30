import { describe, expect, it } from "vitest";
import { readNftOwnedPage } from "./owned";
import type { NftScope } from "./model";
const wallet = "0x1111111111111111111111111111111111111111",
  contract = "0x2222222222222222222222222222222222222222";
const scope: NftScope = {
  slug: "test-only-owned",
  chain: "ethereum",
  contract,
  standard: "erc1155",
  label: "TEST_ONLY",
  charity: false,
};
const expected = { wallet, chainId: 1 };
function page() {
  return {
    wallet,
    chainId: 1,
    data: [
      {
        tokenId: "7",
        name: "TEST_ONLY",
        contract,
        standard: "erc1155",
        collection: scope.slug,
      },
    ],
    next: null as string | null,
    scope,
    source: "opensea",
    observedAt: "2026-10-19T15:00:00.123456789Z",
  };
}
describe("private indexed NFT holdings display binding", () => {
  it("keeps exact authenticated context, indexed source observation and detached asset records", () => {
    const input = page(),
      out = readNftOwnedPage(input, scope, expected);
    expect(out).toMatchObject({
      wallet,
      chainId: 1,
      next: null,
      observedAt: input.observedAt,
      data: [
        {
          tokenId: "7",
          chain: "ethereum",
          contract,
          collection: scope.slug,
          source: "opensea",
        },
      ],
    });
    input.data[0]!.name = "changed";
    expect(out.data[0]!.name).toBe("TEST_ONLY");
  });
  it.each([
    "wallet",
    "chain",
    "scope",
    "record",
    "private",
    "cursor",
    "time",
    "source",
  ])("rejects incompatible %s before display state is replaced", (field) => {
    const value = page();
    if (field === "wallet") value.wallet = contract;
    if (field === "chain") value.chainId = 8453;
    if (field === "scope") value.scope = { ...scope, slug: "other" };
    if (field === "record") value.data[0]!.contract = wallet;
    if (field === "private")
      Reflect.set(value.data[0]!, "accessToken", "TEST_ONLY");
    if (field === "cursor") value.next = "bad\ncursor";
    if (field === "time") value.observedAt = "2026-02-31T00:00:00Z";
    if (field === "source") value.source = "unknown";
    expect(() => readNftOwnedPage(value, scope, expected)).toThrow();
  });
  it.each([null, [], {}, "invalid"].map((value) => ({ value })))(
    "rejects malformed root $value",
    ({ value }) => {
      expect(() => readNftOwnedPage(value, scope, expected)).toThrow();
    },
  );
  it("does not invoke an in-process accessor", () => {
    const value = page();
    let calls = 0;
    Object.defineProperty(value, "wallet", {
      enumerable: true,
      get() {
        calls++;
        return wallet;
      },
    });
    expect(() => readNftOwnedPage(value, scope, expected)).toThrow();
    expect(calls).toBe(0);
  });
  it("retains opaque next-page cursors and does not claim empty holdings mean zero balance", () => {
    const value = { ...page(), data: [], next: "opaque:next==" };
    expect(readNftOwnedPage(value, scope, expected)).toMatchObject({
      data: [],
      next: "opaque:next==",
      observedAt: value.observedAt,
    });
  });
  it("supports the selected Base scope without reclassifying its chain", () => {
    const base = { ...scope, chain: "base" as const };
    expect(
      readNftOwnedPage({ ...page(), scope: base, chainId: 8453 }, base, {
        wallet,
        chainId: 8453,
      }),
    ).toMatchObject({ chainId: 8453, data: [{ chain: "base" }] });
  });
  it("refuses a selected scope that disagrees with the authenticated chain", () => {
    expect(() =>
      readNftOwnedPage(page(), { ...scope, chain: "base" }, expected),
    ).toThrow();
  });
  it("keeps the largest token integer and first duplicated indexed observation", () => {
    const value = page();
    value.data[0]!.tokenId = ((1n << 256n) - 1n).toString();
    value.data.push({ ...value.data[0]!, name: "later" });
    const out = readNftOwnedPage(value, scope, expected);
    expect(out.data).toHaveLength(1);
    expect(out.data[0]!.tokenId).toBe(((1n << 256n) - 1n).toString());
    expect(out.data[0]!.name).toBe("TEST_ONLY");
  });
  it("requires only the existing read context, not alias, UI readiness or historical transactions", () => {
    expect(readNftOwnedPage(page(), scope, expected).data).toHaveLength(1);
  });
});
