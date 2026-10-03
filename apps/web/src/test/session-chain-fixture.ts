import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  multicall3Abi,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

const selectors = Object.fromEntries(
  [
    "reverseWithGateways(bytes,uint256,string[])",
    "ownerOf(uint256)",
    "sellerEpoch(address)",
    "paused()",
    "allowedCollection(address)",
    "allowedAssetToken(address)",
    "allowedPaymentToken(address)",
    "balanceOf(address)",
    "allowance(address,address)",
    "intentUsed(bytes32)",
    "intentFilled(bytes32)",
    "pilotPaymentCap(address,address)",
    "pilotPaymentUsed(address,address)",
    "isApprovedForAll(address,address)",
  ].map((signature) => [toFunctionSelector(signature), signature]),
);

/** TEST_ONLY chain reads, including the native balance RainbowKit wraps in Multicall3. */
export function sessionContractRead(data: Hex, seller: Address): Hex {
  if (data.startsWith(toFunctionSelector("getEthBalance(address)")))
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "getEthBalance",
      result: 10n ** 18n,
    });
  if (
    data.startsWith(toFunctionSelector("aggregate3((address,bool,bytes)[])"))
  ) {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data });
    if (decoded.functionName !== "aggregate3")
      throw new Error("Unsupported TEST_ONLY multicall method.");
    return encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: decoded.args[0].map((call) => ({
        success: true,
        returnData: sessionContractRead(call.callData, seller),
      })),
    });
  }
  const signature = selectors[data.slice(0, 10)];
  switch (signature) {
    case "reverseWithGateways(bytes,uint256,string[])":
      // RainbowKit queries the configured Ethereum transport for the wallet's ENS name.
      // This synthetic account has no name; implement the installed viem resolver ABI.
      return encodeAbiParameters(
        [{ type: "string" }, { type: "address" }, { type: "address" }],
        ["", zeroAddress, zeroAddress],
      );
    case "ownerOf(uint256)":
      return encodeAbiParameters([{ type: "address" }], [seller]);
    case "paused()":
    case "intentUsed(bytes32)":
      return encodeAbiParameters([{ type: "bool" }], [false]);
    case "allowedCollection(address)":
    case "allowedAssetToken(address)":
    case "allowedPaymentToken(address)":
    case "isApprovedForAll(address,address)":
      return encodeAbiParameters([{ type: "bool" }], [true]);
    case "balanceOf(address)":
    case "allowance(address,address)":
    case "pilotPaymentCap(address,address)":
      return encodeAbiParameters([{ type: "uint256" }], [1_000_000_000n]);
    case "sellerEpoch(address)":
    case "intentFilled(bytes32)":
    case "pilotPaymentUsed(address,address)":
      return encodeAbiParameters([{ type: "uint256" }], [0n]);
    default:
      // No permissive fallback: an unimplemented contract read must fail the suite.
      throw new Error("Unsupported TEST_ONLY contract selector.");
  }
}

export type SessionRPCRequest = {
  id: number | string;
  method: string;
  params?: unknown[];
};

export function sessionRPCResult(request: SessionRPCRequest, seller: Address) {
  switch (request.method) {
    case "eth_chainId":
      return "0x88bb0";
    case "eth_blockNumber":
      return "0x64";
    case "eth_getBalance":
      return "0xde0b6b3a7640000";
    case "eth_getCode":
      return "0x";
    case "eth_call": {
      const data = (request.params?.[0] as { data?: Hex } | undefined)?.data;
      if (!data) throw new Error("Missing TEST_ONLY contract calldata.");
      return sessionContractRead(data, seller);
    }
    case "eth_getBlockByNumber":
      return {
        number: "0x64",
        hash: zeroHash,
        parentHash: zeroHash,
        transactions: [],
        gasLimit: "0x1000000",
        gasUsed: "0x0",
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
        extraData: "0x",
        difficulty: "0x0",
        totalDifficulty: "0x0",
        size: "0x1",
        uncles: [],
        miner: zeroAddress,
        nonce: "0x0000000000000000",
        mixHash: zeroHash,
        receiptsRoot: zeroHash,
        stateRoot: zeroHash,
        transactionsRoot: zeroHash,
        sha3Uncles: zeroHash,
        logsBloom: `0x${"00".repeat(256)}`,
        baseFeePerGas: "0x1",
      };
    default:
      throw new Error("Unsupported TEST_ONLY RPC method.");
  }
}
