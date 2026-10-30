import {
  decodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  zeroHash,
  toFunctionSelector,
  type Hex,
} from "viem";
import { charityEditionsAbi, fractionTokenAbi } from "../lib/contracts";

// Contract read fixtures make the real edition surface reachable. They are not
// live collection observations and do not bypass the component's configured reads.
export function editionCall(data: Hex): Hex {
  if (data.startsWith(toFunctionSelector("balanceOf(address)")))
    return encodeFunctionResult({
      abi: fractionTokenAbi,
      functionName: "balanceOf",
      result: 0n,
    });
  // RainbowKit reads the connected account's native balance through Multicall3.
  if (data.startsWith(toFunctionSelector("getEthBalance(address)")))
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "getEthBalance",
      result: 0n,
    });
  if (data.startsWith("0x82ad56cb")) {
    const call = decodeFunctionData({ abi: multicall3Abi, data });
    if (call.functionName !== "aggregate3")
      throw new Error("Unexpected multicall fixture method");
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: call.args[0].map((call) => ({
        success: true,
        returnData: editionCall(call.callData),
      })),
    });
  }
  const { functionName } = decodeFunctionData({
    abi: charityEditionsAbi,
    data,
  });
  switch (functionName) {
    case "series":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: {
          artworkId: `0x${"11".repeat(32)}`,
          masterArtworkHash: `0x${"22".repeat(32)}`,
          metadataHash: `0x${"33".repeat(32)}`,
          distributionWallet: "0x1000000000000000000000000000000000000030",
          createdAt: 1760000000n,
          soldOutAt: 0n,
          physicalDonationRecordedAt: 0n,
          selloutEvidenceHash: zeroHash,
          physicalDonationEvidenceHash: zeroHash,
          metadataURI: "ipfs://TEST_ONLY-edition-1",
        },
      });
    case "totalSupply":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: 100n,
      });
    case "balanceOf":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: 63n,
      });
    case "PRIMARY_PRICE_WEI":
      return encodeFunctionResult({
        abi: charityEditionsAbi,
        functionName,
        result: 10000000000000000n,
      });
    default:
      throw new Error(`Unexpected charity fixture read: ${functionName}`);
  }
}

// Stable JSON-RPC block for the same immutable edition observation used by the UI fixtures.
export function editionBlock() {
  return {
    number: "0x64",
    hash: `0x${"aa".repeat(32)}`,
    parentHash: zeroHash,
    timestamp: `0x${(1760000100).toString(16)}`,
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    size: "0x1",
    baseFeePerGas: "0x1",
    extraData: "0x",
    logsBloom: `0x${"00".repeat(256)}`,
    miner: "0x1000000000000000000000000000000000000030",
    mixHash: zeroHash,
    receiptsRoot: zeroHash,
    stateRoot: zeroHash,
    transactionsRoot: zeroHash,
    sha3Uncles: zeroHash,
    transactions: [],
    uncles: [],
  };
}
