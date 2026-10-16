import { describe, expect, it } from "vitest";
import {
  filterNftHistoryPage,
  nftHistoryMeaning,
  nftHistoryStatuses,
  readNftHistoryPage,
} from "./history-view";
import type { NftOperationHistory, NftOperationSummary } from "./model";

const wallet = "0x" + "a".repeat(40),
  transactionHash = "0x" + "1".repeat(64),
  orderHash = "0x" + "2".repeat(64);
const expected = { wallet, chainId: 1, page: 1 };
function row(patch: Partial<NftOperationSummary> = {}): NftOperationSummary {
  return {
    id: "TEST_ONLY-operation-0001",
    chainId: 1,
    action: "list",
    status: "accepted",
    collection: "test-only-collection",
    tokenId: "7",
    kind: "signature",
    walletStarted: true,
    orderHash,
    updatedAt: "2026-10-15T18:00:00.123456789Z",
    ...patch,
  };
}
function page(data = [row()]): NftOperationHistory {
  return { wallet, chainId: 1, page: 1, pageSize: 25, hasMore: false, data };
}

describe("private NFT history display admission", () => {
  it("retains exact operation IDs, large token IDs, references and nanosecond source timestamps", () => {
    const tokenId = ((1n << 256n) - 1n).toString();
    const source = page([
      row({ kind: "transaction", tokenId, transactionHash }),
    ]);
    const result = readNftHistoryPage(source, expected);
    expect(result).toEqual(source);
    expect(result.data[0]!.tokenId).toBe(tokenId);
    source.data[0]!.status = "failed";
    expect(result.data[0]!.status).toBe("accepted");
  });
  it.each([1, 8453])(
    "binds every row and envelope to supported chain %s",
    (chainId) => {
      const source = { ...page([row({ chainId })]), chainId };
      expect(readNftHistoryPage(source, { ...expected, chainId }).chainId).toBe(
        chainId,
      );
      const foreignRow = {
        ...source,
        data: [row({ chainId: chainId === 1 ? 8453 : 1 })],
      };
      expect(() =>
        readNftHistoryPage(foreignRow, { ...expected, chainId }),
      ).toThrow();
    },
  );
  it("rejects a foreign wallet, chain, requested page or malformed pagination", () => {
    for (const patch of [
      { wallet: "0x" + "b".repeat(40) },
      { chainId: 8453 },
      { page: 2 },
      { page: "1" },
      { pageSize: 24 },
      { hasMore: "false" },
      { data: null },
    ])
      expect(() =>
        readNftHistoryPage({ ...page(), ...patch }, expected),
      ).toThrow();
    for (const patch of [
      { chainId: 560048 },
      { page: 0 },
      { page: 1.5 },
      { page: 1000000 },
    ])
      expect(() =>
        readNftHistoryPage(page(), { ...expected, ...patch }),
      ).toThrow();
    expect(() =>
      readNftHistoryPage({ ...page(), wallet: undefined }, expected),
    ).toThrow();
  });
  it("does not infer history completion from page length", () => {
    expect(
      readNftHistoryPage({ ...page([]), hasMore: true }, expected).hasMore,
    ).toBe(true);
    expect(readNftHistoryPage(page([]), expected).hasMore).toBe(false);
  });
  it("rejects duplicate IDs, sparse arrays, oversized pages and any malformed row atomically", () => {
    const sources = [
      page([row(), row()]),
      page(
        Array.from({ length: 26 }, (_, n) =>
          row({ id: "TEST_ONLY-operation-" + String(n).padStart(4, "0") }),
        ),
      ),
      { ...page(), data: new Array(2) },
      page([row(), { ...row(), id: "short" }]),
    ];
    for (const source of sources)
      expect(() => readNftHistoryPage(source, expected)).toThrow();
    for (const patch of [
      { id: "bad:operation:identifier" },
      { action: "execute" },
      { status: "paid" },
      { kind: "rawTransaction" },
      { walletStarted: undefined },
      { walletStarted: "true" },
      { tokenId: "01" },
      { tokenId: 1 },
      { tokenId: (1n << 256n).toString() },
      { collection: "Other Collection" },
      { transactionHash: "0x1" },
      { orderHash: "" },
      { updatedAt: "2026-02-30T00:00:00Z" },
      { updatedAt: "2026-10-15T18:00:00+00:00" },
      { updatedAt: "not a time" },
    ])
      expect(() =>
        readNftHistoryPage(
          page([
            row(),
            { ...row({ id: "TEST_ONLY-operation-0002" }), ...patch },
          ] as NftOperationSummary[]),
          expected,
        ),
      ).toThrow();
  });
  it("preserves fine-grained source order and rejects a newer row after an older one", () => {
    const first = row({ updatedAt: "2026-10-15T18:00:00.000000002Z" });
    const second = row({
      id: "TEST_ONLY-operation-0002",
      updatedAt: "2026-10-15T18:00:00.000000001Z",
    });
    expect(
      readNftHistoryPage(page([first, second]), expected).data,
    ).toHaveLength(2);
    expect(() => readNftHistoryPage(page([second, first]), expected)).toThrow();
  });
  it("rejects unsupported/private fields instead of copying them into display state", () => {
    for (const key of [
      "plan",
      "signature",
      "capability",
      "accessToken",
      "privateKey",
    ]) {
      expect(() =>
        readNftHistoryPage({ ...page(), [key]: "TEST_ONLY" }, expected),
      ).toThrow();
      expect(() =>
        readNftHistoryPage(page([{ ...row(), [key]: "TEST_ONLY" }]), expected),
      ).toThrow();
    }
  });
  it("does not invoke in-process accessors", () => {
    let calls = 0;
    const source = row();
    Object.defineProperty(source, "tokenId", {
      get() {
        calls++;
        return "7";
      },
      enumerable: true,
    });
    expect(() => readNftHistoryPage(page([source]), expected)).toThrow();
    expect(calls).toBe(0);
  });
});

describe("page-local NFT history discovery and status semantics", () => {
  const data = page([
    row(),
    row({
      id: "TEST_ONLY-operation-0002",
      action: "buy",
      status: "pending",
      kind: "transaction",
      transactionHash,
      orderHash: undefined,
    }),
  ]);
  it("filters only the supplied page and keeps its source order and metadata unchanged", () => {
    const filter = {
      action: "buy",
      status: "pending",
      query: "OPERATION-0002",
    };
    expect(filterNftHistoryPage(data, filter).map((item) => item.id)).toEqual([
      "TEST_ONLY-operation-0002",
    ]);
    expect(
      filterNftHistoryPage(data, {
        action: "all",
        status: "all",
        query: "not on this page",
      }),
    ).toEqual([]);
    expect(data.data).toHaveLength(2);
    expect(data.hasMore).toBe(false);
  });
  it("finds full transaction/order references, token and collection without numeric coercion", () => {
    for (const query of [transactionHash, "test-only-collection", "7"])
      expect(
        filterNftHistoryPage(data, { action: "all", status: "all", query })
          .length,
      ).toBeGreaterThan(0);
    expect(
      filterNftHistoryPage(data, {
        action: "all",
        status: "all",
        query: orderHash,
      })[0]!.kind,
    ).toBe("signature");
    expect(() =>
      filterNftHistoryPage(data, {
        action: "execute",
        status: "all",
        query: "",
      }),
    ).toThrow();
    expect(() =>
      filterNftHistoryPage(data, { action: "all", status: "paid", query: "" }),
    ).toThrow();
    expect(() =>
      filterNftHistoryPage(data, {
        action: "all",
        status: "all",
        query: "x".repeat(201),
      }),
    ).toThrow();
  });
  it("distinguishes venue acceptance, approval confirmation and pending reconciliation", () => {
    expect(nftHistoryMeaning(row())).toMatch(/does not establish settlement/);
    expect(
      nftHistoryMeaning(row({ status: "confirmed", kind: "approval" })),
    ).toMatch(/does not publish or settle/);
    expect(
      nftHistoryMeaning(row({ status: "confirmed", kind: "transaction" })),
    ).toMatch(/not a fresh venue or chain observation/);
    expect(nftHistoryMeaning(row({ status: "pending" }))).toMatch(/reconcile/);
    expect(nftHistoryMeaning(row({ status: "cancelled" }))).toMatch(
      /discarded review/,
    );
    expect(
      nftHistoryMeaning(
        row({ status: "awaiting-wallet", walletStarted: true }),
      ),
    ).toMatch(/Recover its outcome/);
    expect(
      nftHistoryMeaning(
        row({ status: "awaiting-wallet", walletStarted: false }),
      ),
    ).toMatch(/unsigned review/);
    for (const status of nftHistoryStatuses)
      expect(nftHistoryMeaning(row({ status }))).not.toBe("");
  });
});
