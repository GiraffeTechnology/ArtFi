import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionResult,
  encodeFunctionData,
  multicall3Abi,
  zeroAddress,
} from "viem";
import { mainnet } from "viem/chains";
import { fractionTokenAbi, wholeArtworkCollectionAbi } from "../lib/contracts";
import { sessionContractRead, sessionRPCResult } from "./session-chain-fixture";

const seller = "0x1000000000000000000000000000000000000010";

describe("TEST_ONLY session read-only chain fixture", () => {
  it("encodes native balance, ERC20 balance and ERC721 owner reads inside a real Multicall3 result", () => {
    const native = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "getEthBalance",
      args: [seller],
    });
    const balance = encodeFunctionData({
      abi: fractionTokenAbi,
      functionName: "balanceOf",
      args: [seller],
    });
    const owner = encodeFunctionData({
      abi: wholeArtworkCollectionAbi,
      functionName: "ownerOf",
      args: [1n],
    });
    const request = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [
        [native, balance, owner].map((callData) => ({
          target: zeroAddress,
          allowFailure: true,
          callData,
        })),
      ],
    });
    const results = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      data: sessionContractRead(request, seller),
    });
    expect(results.map((result) => result.success)).toEqual([true, true, true]);
    expect(
      decodeFunctionResult({
        abi: multicall3Abi,
        functionName: "getEthBalance",
        data: results[0].returnData,
      }),
    ).toBe(10n ** 18n);
    expect(
      decodeFunctionResult({
        abi: fractionTokenAbi,
        functionName: "balanceOf",
        data: results[1].returnData,
      }),
    ).toBe(1_000_000_000n);
    expect(
      decodeFunctionResult({
        abi: wholeArtworkCollectionAbi,
        functionName: "ownerOf",
        data: results[2].returnData,
      }).toLowerCase(),
    ).toBe(seller);
  });

  it("answers the installed ENS lookup used by RainbowKit with no synthetic name", async () => {
    const client = createPublicClient({
      chain: mainnet,
      transport: custom(
        {
          async request(request) {
            return sessionRPCResult({ id: 1, ...request }, seller);
          },
        },
        { retryCount: 0 },
      ),
    });
    await expect(
      client.getEnsName({ address: seller, strict: true }),
    ).resolves.toBeNull();
  });

  it("refuses unknown selectors even when Multicall3 allows failures", () => {
    expect(() => sessionContractRead("0xdeadbeef", seller)).toThrow(
      "Unsupported TEST_ONLY contract selector",
    );
    const request = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [
        [{ target: zeroAddress, allowFailure: true, callData: "0xdeadbeef" }],
      ],
    });
    expect(() => sessionContractRead(request, seller)).toThrow(
      "Unsupported TEST_ONLY contract selector",
    );
  });

  it("keeps a pinned block stable when wall time advances", () => {
    const read = (tag: string, time: number) =>
      sessionRPCResult(
        { id: 1, method: "eth_getBlockByNumber", params: [tag, false] },
        seller,
        () => time,
      );
    const initial = read("latest", 100_000);
    expect(read("0x64", 101_000)).toEqual(initial);
    expect(read("latest", 101_000)).not.toEqual(initial);
    expect(() => read("pending", 101_000)).toThrow(
      "Unsupported TEST_ONLY block tag",
    );
    expect(() => read("0x66", 101_000)).toThrow("Future TEST_ONLY block");
  });

  it("rejects blockchain writes and unimplemented RPC instead of reporting success", () => {
    for (const method of [
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "wallet_sendCalls",
      "unknown",
    ]) {
      expect(() =>
        sessionRPCResult({ id: 1, method, params: [] }, seller),
      ).toThrow("Unsupported TEST_ONLY RPC method");
    }
    expect(sessionRPCResult({ id: 1, method: "eth_chainId" }, seller)).toBe(
      "0x88bb0",
    );
  });
});
