import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import {
  readRevenueDistributionInventory,
  revenueDistributionIds,
  type RevenueDistributionInventory,
} from "./revenue-distribution-discovery";
import {
  RevenueDistributionBrowser,
  RevenueDistributionSelection,
} from "../components/revenue-distribution-browser";
const distributor = ("0x" + "1".repeat(40)) as Address;
const fractionToken = ("0x" + "2".repeat(40)) as Address;
const account = ("0x" + "3".repeat(40)) as Address;
const hash = "0x" + "a".repeat(64);
const binding = { distributor, fractionToken, account };
const inventory = (count = 25n): RevenueDistributionInventory => ({
  ...binding,
  count,
  blockNumber: 50n,
  blockHash: hash,
});
function fixture() {
  const chain = vi.fn().mockResolvedValue(560048);
  const block = vi.fn().mockResolvedValue({ number: 50n, hash });
  const code = vi.fn().mockResolvedValue("0x6000");
  const read = vi.fn<(request: { functionName: string }) => Promise<unknown>>(
    async ({ functionName }) =>
      functionName === "fractionToken" ? fractionToken : 25n,
  );
  return {
    client: {
      getChainId: chain,
      getBlock: block,
      getCode: code,
      readContract: read,
    } as unknown as PublicClient,
    chain,
    block,
    code,
    read,
  };
}
describe("deployed revenue distribution discovery", () => {
  it("reads the configured count and token at one mined canonical block", async () => {
    const f = fixture();
    const result = await readRevenueDistributionInventory(f.client, binding);
    expect(result).toEqual(inventory());
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.code.mock.calls).toEqual([
      [{ address: distributor, blockNumber: 50n }],
      [{ address: fractionToken, blockNumber: 50n }],
    ]);
    expect(f.read.mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address: distributor,
          blockNumber: 50n,
          functionName: "fractionToken",
        }),
        expect.objectContaining({
          address: distributor,
          blockNumber: 50n,
          functionName: "distributionCount",
        }),
      ]),
    );
    expect(f.block).toHaveBeenLastCalledWith({ blockNumber: 50n });
  });
  it("captures caller binding before asynchronous chain reads", async () => {
    const f = fixture();
    let resolve!: (value: number) => void;
    f.chain.mockImplementationOnce(
      () =>
        new Promise<number>((yes) => {
          resolve = yes;
        }),
    );
    const mutable = { ...binding };
    const pending = readRevenueDistributionInventory(f.client, mutable);
    mutable.account = distributor;
    mutable.distributor = account;
    mutable.fractionToken = account;
    resolve(560048);
    expect(await pending).toEqual(inventory());
    expect(f.read.mock.calls[0][0]).toMatchObject({ address: distributor });
  });
  it("captures the original block hash instead of trusting a later-mutated response object", async () => {
    const f = fixture(),
      shared = { number: 50n, hash };
    f.block.mockResolvedValue(shared);
    f.read.mockImplementation(async ({ functionName }) => {
      shared.hash = "0x" + "b".repeat(64);
      return functionName === "fractionToken" ? fractionToken : 25n;
    });
    await expect(
      readRevenueDistributionInventory(f.client, binding),
    ).rejects.toThrow("changed");
  });
  it("refuses invalid bindings before any RPC", async () => {
    const f = fixture();
    await expect(
      readRevenueDistributionInventory(f.client, {
        ...binding,
        account: "0x0" as Address,
      }),
    ).rejects.toThrow("binding");
    expect(f.chain).not.toHaveBeenCalled();
  });
  it.each([1, 0, 560049])(
    "refuses unsupported chain %s before inventory reads",
    async (chain) => {
      const f = fixture();
      f.chain.mockResolvedValue(chain);
      await expect(
        readRevenueDistributionInventory(f.client, binding),
      ).rejects.toThrow("Hoodi");
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it.each([
    { number: null, hash },
    { number: -1n, hash },
    { number: 50n, hash: null },
    { number: 50n, hash: "0x01" },
  ])("refuses unmined or malformed block %o", async (value) => {
    const f = fixture();
    f.block.mockResolvedValue(value);
    await expect(
      readRevenueDistributionInventory(f.client, binding),
    ).rejects.toThrow("mined");
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([
    "distributor",
    "token",
    "association",
    "negative-count",
    "overflow-count",
    "numeric-count",
  ])("does not turn invalid %s into empty inventory", async (failure) => {
    const f = fixture();
    if (failure === "distributor") f.code.mockResolvedValueOnce("0x");
    if (failure === "token")
      f.code.mockResolvedValueOnce("0x6000").mockResolvedValueOnce(undefined);
    if (failure === "association")
      f.read.mockImplementation(async ({ functionName }) =>
        functionName === "fractionToken" ? account : 25n,
      );
    if (failure.endsWith("count"))
      f.read.mockImplementation(async ({ functionName }) =>
        functionName === "fractionToken"
          ? fractionToken
          : failure === "negative-count"
            ? -1n
            : failure === "overflow-count"
              ? 1n << 256n
              : 25,
      );
    await expect(
      readRevenueDistributionInventory(f.client, binding),
    ).rejects.toThrow("configured token");
  });
  it.each(["hash", "number", "chain"])(
    "refuses changed canonical %s",
    async (failure) => {
      const f = fixture();
      if (failure === "hash")
        f.block
          .mockResolvedValueOnce({ number: 50n, hash })
          .mockResolvedValueOnce({ number: 50n, hash: "0x" + "b".repeat(64) });
      if (failure === "number")
        f.block
          .mockResolvedValueOnce({ number: 50n, hash })
          .mockResolvedValueOnce({ number: 51n, hash });
      if (failure === "chain")
        f.chain.mockResolvedValueOnce(560048).mockResolvedValueOnce(1);
      await expect(
        readRevenueDistributionInventory(f.client, binding),
      ).rejects.toThrow("changed");
    },
  );
  it("retains RPC failure instead of reporting zero distributions", async () => {
    const f = fixture();
    f.read.mockRejectedValue(new Error("unavailable"));
    await expect(
      readRevenueDistributionInventory(f.client, binding),
    ).rejects.toThrow("unavailable");
  });
});
describe("bounded distribution ID pages", () => {
  it("lists newest first and retains an exact ten-ID bound", () => {
    expect(revenueDistributionIds(inventory(), 0n)).toEqual({
      ids: [25n, 24n, 23n, 22n, 21n, 20n, 19n, 18n, 17n, 16n],
      offset: 0n,
      newer: false,
      older: true,
    });
    expect(revenueDistributionIds(inventory(), 20n)).toEqual({
      ids: [5n, 4n, 3n, 2n, 1n],
      offset: 20n,
      newer: true,
      older: false,
    });
  });
  it("clamps stale offsets and handles an observed empty distributor", () => {
    expect(revenueDistributionIds(inventory(3n), 20n).ids).toEqual([
      3n,
      2n,
      1n,
    ]);
    expect(revenueDistributionIds(inventory(0n), 0n)).toEqual({
      ids: [],
      offset: 0n,
      newer: false,
      older: false,
    });
    expect(revenueDistributionIds(inventory(), 15n).offset).toBe(10n);
  });
  it("does not truncate uint256 IDs to Number or allocate the entire inventory", () => {
    const maximum = (1n << 256n) - 1n;
    const first = revenueDistributionIds(inventory(maximum), 0n);
    expect(first.ids).toHaveLength(10);
    expect(first.ids[0]).toBe(maximum);
    const last = revenueDistributionIds(inventory(maximum), maximum);
    expect(last.ids).toEqual([5n, 4n, 3n, 2n, 1n]);
    expect(Object.isFrozen(last.ids)).toBe(true);
  });
  it("rejects invalid offsets and count instead of producing synthetic IDs", () => {
    expect(() => revenueDistributionIds(inventory(), -1n)).toThrow("page");
    expect(() => revenueDistributionIds(inventory(1n << 256n), 0n)).toThrow(
      "page",
    );
  });
});
describe("revenue discovery static interface", () => {
  it("renders exact bounded IDs and observation without signing or selecting", () => {
    const select = vi.fn(),
      offset = vi.fn();
    const html = renderToStaticMarkup(
      createElement(RevenueDistributionSelection, {
        inventory: inventory(),
        offset: 0n,
        disabled: false,
        onOffset: offset,
        onSelect: select,
      }),
    );
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).toContain(hash);
    expect(html).toContain("25 distribution IDs observed at block 50");
    expect(html).toContain("this list confirms no payment or claim");
    expect(html).toContain('disabled="">Newer distribution IDs');
    expect(select).not.toHaveBeenCalled();
    expect(offset).not.toHaveBeenCalled();
  });
  it("keeps selectors disabled during an existing pending action", () => {
    const html = renderToStaticMarkup(
      createElement(RevenueDistributionSelection, {
        inventory: inventory(1n),
        offset: 0n,
        disabled: true,
        onOffset: () => {},
        onSelect: () => {},
      }),
    );
    expect(html).toContain('disabled="">Read distribution');
    expect(html).not.toContain("Revenue distribution pages");
  });
  it("distinguishes a verified zero range from an unread or unavailable range", () => {
    const empty = renderToStaticMarkup(
      createElement(RevenueDistributionSelection, {
        inventory: inventory(0n),
        offset: 0n,
        disabled: false,
        onOffset: () => {},
        onSelect: () => {},
      }),
    );
    expect(empty).toContain("No distributions existed at this observed block");
    const auth = vi.fn(async () => {}),
      select = vi.fn();
    const unread = renderToStaticMarkup(
      createElement(RevenueDistributionBrowser, {
        client: undefined,
        binding,
        disabled: false,
        beforeRead: auth,
        onSelect: select,
      }),
    );
    expect(unread).not.toContain("No distributions existed");
    expect(unread).toContain('disabled="">Read available distribution IDs');
    expect(auth).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
