import { describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, multicall3Abi } from "viem";
import { charityEditionsAbi, fractionTokenAbi } from "../lib/contracts";
import { editionCall } from "./flow-chain-fixture";
const collection = "0x1000000000000000000000000000000000000006";
const wallet = "0x1000000000000000000000000000000000000010";

describe("configured flow browser RPC fixture", () => {
  it("encodes the actual edition series, supply, ERC-1155 balance and price", () => {
    const series = decodeFunctionResult({
      abi: charityEditionsAbi,
      functionName: "series",
      data: editionCall(
        encodeFunctionData({
          abi: charityEditionsAbi,
          functionName: "series",
          args: [1n],
        }),
      ),
    });
    expect(series).toMatchObject({
      metadataURI: "ipfs://TEST_ONLY-edition-1",
      createdAt: 1760000000n,
      soldOutAt: 0n,
    });
    expect(
      decodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "totalSupply",
        data: editionCall(
          encodeFunctionData({
            abi: charityEditionsAbi,
            functionName: "totalSupply",
            args: [1n],
          }),
        ),
      }),
    ).toBe(100n);
    expect(
      decodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "balanceOf",
        data: editionCall(
          encodeFunctionData({
            abi: charityEditionsAbi,
            functionName: "balanceOf",
            args: [wallet, 1n],
          }),
        ),
      }),
    ).toBe(63n);
    expect(
      decodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "PRIMARY_PRICE_WEI",
        data: editionCall(
          encodeFunctionData({
            abi: charityEditionsAbi,
            functionName: "PRIMARY_PRICE_WEI",
          }),
        ),
      }),
    ).toBe(10000000000000000n);
  });
  it("handles mixed Multicall3 native balance, ERC-20 balance and edition reads", () => {
    const calls = [
      {
        target: collection,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: multicall3Abi,
          functionName: "getEthBalance",
          args: [wallet],
        }),
      },
      {
        target: collection,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: fractionTokenAbi,
          functionName: "balanceOf",
          args: [wallet],
        }),
      },
      {
        target: collection,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: charityEditionsAbi,
          functionName: "totalSupply",
          args: [1n],
        }),
      },
    ] as const;
    const result = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      data: editionCall(
        encodeFunctionData({
          abi: multicall3Abi,
          functionName: "aggregate3",
          args: [calls],
        }),
      ),
    });
    expect(result.map((call) => call.success)).toEqual([true, true, true]);
    expect(
      decodeFunctionResult({
        abi: multicall3Abi,
        functionName: "getEthBalance",
        data: result[0].returnData,
      }),
    ).toBe(0n);
    expect(
      decodeFunctionResult({
        abi: fractionTokenAbi,
        functionName: "balanceOf",
        data: result[1].returnData,
      }),
    ).toBe(0n);
    expect(
      decodeFunctionResult({
        abi: charityEditionsAbi,
        functionName: "totalSupply",
        data: result[2].returnData,
      }),
    ).toBe(100n);
  });
  it("refuses an unknown call instead of pretending to have read contract facts", () => {
    expect(() => editionCall("0x12345678")).toThrow();
  });
});
