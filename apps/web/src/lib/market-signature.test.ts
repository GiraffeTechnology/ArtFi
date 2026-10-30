import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  verifyCanonicalEOASignature,
  verifyMarketSignature,
} from "./market-signature";

// Public deterministic test account only; never used for live transactions.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const digest = `0x${"22".repeat(32)}` as Hex;
const market = "0x1000000000000000000000000000000000000001";
const order =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "bytes" }],
    outputs: [{ type: "bytes4" }],
  },
] as const;

describe("market signature contract parity", () => {
  it("accepts only the exact digest and seller for a canonical EOA signature", async () => {
    const signature = await account.sign({ hash: digest });
    expect(
      await verifyCanonicalEOASignature(account.address, digest, signature),
    ).toBe(true);
    expect(await verifyCanonicalEOASignature(market, digest, signature)).toBe(
      false,
    );
    expect(
      await verifyCanonicalEOASignature(
        account.address,
        `0x${"33".repeat(32)}`,
        signature,
      ),
    ).toBe(false);
  });
  it("rejects high-s, v=0/1, compact and malformed EOA encodings without normalization", async () => {
    const signature = await account.sign({ hash: digest });
    const s = BigInt(`0x${signature.slice(66, 130)}`);
    const v = Number.parseInt(signature.slice(130), 16);
    const high =
      `${signature.slice(0, 66)}${(order - s).toString(16).padStart(64, "0")}${v === 27 ? "1c" : "1b"}` as Hex;
    for (const candidate of [
      high,
      `${signature.slice(0, 130)}${(v - 27).toString(16).padStart(2, "0")}`,
      signature.slice(0, 130),
      "0x",
      "0x1",
      `0x${"00".repeat(65)}`,
    ]) {
      expect(
        await verifyCanonicalEOASignature(
          account.address,
          digest,
          candidate as Hex,
        ),
      ).toBe(false);
    }
  });
  it.each(["0x", "0x1234", `0x${"01".repeat(65)}`] as Hex[])(
    "passes original contract-wallet bytes %s with the market caller at the same block",
    async (signature) => {
      const getCode = vi.fn().mockResolvedValue("0x6000");
      const call = vi
        .fn()
        .mockResolvedValue({ data: `0x1626ba7e${"00".repeat(28)}` });
      const client = { getCode, call } as unknown as PublicClient;
      expect(
        await verifyMarketSignature(
          client,
          account.address,
          market,
          digest,
          signature,
          12n,
        ),
      ).toBe(true);
      expect(getCode).toHaveBeenCalledWith({
        address: account.address,
        blockNumber: 12n,
      });
      expect(call.mock.calls[0][0]).toMatchObject({
        account: market,
        to: account.address,
        blockNumber: 12n,
      });
      expect(
        decodeFunctionData({ abi, data: call.mock.calls[0][0].data }).args,
      ).toEqual([digest, signature]);
    },
  );
  it.each([
    "0x1626ba7e",
    `0xffffffff${"00".repeat(28)}`,
    `0x1626ba7e${"01".repeat(28)}`,
    undefined,
  ])("rejects invalid EIP-1271 return data %s", async (data) => {
    const client = {
      getCode: vi.fn().mockResolvedValue("0x6000"),
      call: vi.fn().mockResolvedValue({ data }),
    } as unknown as PublicClient;
    expect(
      await verifyMarketSignature(
        client,
        account.address,
        market,
        digest,
        "0x",
        12n,
      ),
    ).toBe(false);
  });
  it("never falls back to EOA verification when a contract wallet rejects or RPC fails", async () => {
    const signature = await account.sign({ hash: digest });
    const call = vi.fn().mockRejectedValue(new Error("contract reverted"));
    const client = {
      getCode: vi.fn().mockResolvedValue("0x6000"),
      call,
    } as unknown as PublicClient;
    await expect(
      verifyMarketSignature(
        client,
        account.address,
        market,
        digest,
        signature,
        12n,
      ),
    ).rejects.toThrow("contract reverted");
  });
});
