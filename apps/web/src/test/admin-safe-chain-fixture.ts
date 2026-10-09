import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  toFunctionSelector,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  artFiAdminSafeAbi,
  charityEditionsAbi,
  vaultFactoryAbi,
} from "../lib/contracts";
import { createSetupChainFixture, setupAddresses } from "./setup-chain-fixture";

export const safeTestAddresses = {
  ...setupAddresses,
  safe: "0x1000000000000000000000000000000000000055",
  charity: "0x1000000000000000000000000000000000000006",
} as const;
const owners: Address[] = [
  safeTestAddresses.wallet,
  safeTestAddresses.otherWallet,
];
const blockHash = `0x${"95".repeat(32)}` as Hex;
const bloom = `0x${"00".repeat(256)}`;
type Proposal = {
  requestId: Hex;
  target: Address;
  value: bigint;
  data: Hex;
  readyAt: bigint;
  confirmations: number;
  executed: boolean;
  confirmed: Set<string>;
};
type Transaction = {
  from: Address;
  to: Address;
  data: Hex;
  hash: Hex;
  nonce: number;
  mined: boolean;
  logs: unknown[];
};

/** TEST_ONLY isolated RPC model. No requests leave the browser fixture and no wallet signs. */
export function createAdminSafeChainFixture() {
  const base = createSetupChainFixture();
  const state = {
    now: 1_800_000_000n,
    proposals: [] as Proposal[],
    transactions: [] as Transaction[],
    unknownCalls: [] as string[],
    receiptPending: false,
    editionCreated: false,
  };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const encode = (
    type: "uint256" | "bool" | "bytes32",
    value: bigint | boolean | Hex,
  ) => encodeAbiParameters([{ type }], [value]);
  function proposal(id: bigint) {
    const item = state.proposals[Number(id) - 1];
    if (!item) throw Error("TEST_ONLY unknown proposal");
    return item;
  }
  function read(to: Address, data: Hex, from?: Address): Hex {
    if (
      data.startsWith(toFunctionSelector("aggregate3((address,bool,bytes)[])"))
    ) {
      const call = decodeFunctionData({ abi: multicall3Abi, data });
      if (call.functionName !== "aggregate3")
        throw Error("TEST_ONLY unsupported multicall");
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: call.args[0].map((item) => {
          try {
            return {
              success: true,
              returnData: read(item.target, item.callData, from),
            };
          } catch {
            return { success: false, returnData: "0x" as Hex };
          }
        }),
      });
    }
    const lastCreate = [...base.state.transactions]
      .reverse()
      .find((transaction) => transaction.action === "create");
    const vaultCall = lastCreate
      ? decodeFunctionData({ abi: vaultFactoryAbi, data: lastCreate.data })
      : undefined;
    if (
      same(to, safeTestAddresses.vault) &&
      data.startsWith(toFunctionSelector("tokenAdmin()")) &&
      vaultCall?.functionName === "createVault"
    )
      return encodeAbiParameters([{ type: "address" }], [vaultCall.args[4]]);
    if (data.startsWith(toFunctionSelector("hasRole(bytes32,address)"))) {
      const call = decodeFunctionData({ abi: charityEditionsAbi, data });
      if (call.functionName !== "hasRole") throw Error("TEST_ONLY role decode");
      if (
        same(to, safeTestAddresses.vault) &&
        vaultCall?.functionName === "createVault"
      ) {
        const expected =
          call.args[0] === zeroHash
            ? vaultCall.args[4]
            : call.args[0] ===
                keccak256(new TextEncoder().encode("PAUSER_ROLE"))
              ? vaultCall.args[5]
              : vaultCall.args[6];
        return encode("bool", same(call.args[1], expected));
      }
      return encode("bool", same(call.args[1], safeTestAddresses.safe));
    }
    if (same(to, safeTestAddresses.safe)) {
      const call = decodeFunctionData({ abi: artFiAdminSafeAbi, data });
      switch (call.functionName) {
        case "owners":
          return encodeFunctionResult({
            abi: artFiAdminSafeAbi,
            functionName: "owners",
            result: owners,
          });
        case "threshold":
          return encode("uint256", 2n);
        case "delaySeconds":
          return encode("uint256", 60n);
        case "isOwner":
          return encode(
            "bool",
            owners.some((owner) => same(owner, call.args[0])),
          );
        case "transactionCount":
          return encode("uint256", BigInt(state.proposals.length));
        case "transaction":
          return encodeFunctionResult({
            abi: artFiAdminSafeAbi,
            functionName: "transaction",
            result: proposal(call.args[0]),
          });
        case "confirmedBy":
          return encode(
            "bool",
            proposal(call.args[0]).confirmed.has(call.args[1].toLowerCase()),
          );
        case "submit": {
          const existing = state.proposals.findIndex(
            (proposal) => proposal.requestId === call.args[0],
          );
          return encode(
            "uint256",
            BigInt(existing >= 0 ? existing + 1 : state.proposals.length + 1),
          );
        }
        case "confirm":
        case "revoke":
          return "0x";
        case "execute": {
          const p = proposal(call.args[0]);
          if (
            p.confirmations < 2 ||
            p.readyAt === 0n ||
            p.readyAt > state.now ||
            p.executed
          )
            throw Error("TEST_ONLY proposal not executable");
          return encodeFunctionResult({
            abi: artFiAdminSafeAbi,
            functionName: "execute",
            result: "0x",
          });
        }
      }
    }
    if (same(to, safeTestAddresses.charity)) {
      const call = decodeFunctionData({ abi: charityEditionsAbi, data });
      switch (call.functionName) {
        case "SERIES_CREATOR_ROLE":
          return encode(
            "bytes32",
            keccak256(new TextEncoder().encode("SERIES_CREATOR_ROLE")),
          );
        case "EDITIONS_PER_ARTWORK":
          return encode("uint256", 100n);
        case "PRIMARY_PRICE_WEI":
          return encode("uint256", 10_000_000_000_000_000n);
        case "seriesCount":
          return encode("uint256", state.editionCreated ? 1n : 0n);
        case "paused":
          return encode("bool", false);
        case "totalSupply":
        case "balanceOf":
          return encode("uint256", state.editionCreated ? 100n : 0n);
        case "createSeries":
          return encode("uint256", 1n);
        default:
          throw Error(
            `TEST_ONLY unsupported charity read ${call.functionName}`,
          );
      }
    }
    const result = base.rpc({
      id: 1,
      method: "eth_call",
      params: [{ to, data, from }],
    });
    if (result.error) throw Error(result.error.message);
    return result.result as Hex;
  }
  function submit(input: { from: Address; to: Address; data: Hex }) {
    if (!same(input.to, safeTestAddresses.safe))
      throw Error("TEST_ONLY expected a safe wallet request");
    const nonce = state.transactions.length;
    const hash = `0x${(10000 + nonce).toString(16).padStart(64, "0")}` as Hex;
    state.transactions.push({ ...input, hash, nonce, mined: false, logs: [] });
    return hash;
  }
  function mine(tx: Transaction) {
    if (tx.mined) return;
    const call = decodeFunctionData({ abi: artFiAdminSafeAbi, data: tx.data });
    const logBase = {
      address: safeTestAddresses.safe,
      blockHash,
      blockNumber: "0x64",
      transactionHash: tx.hash,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
    if (call.functionName === "submit") {
      const [requestId, target, value, data] = call.args;
      state.proposals.push({
        requestId,
        target,
        value,
        data,
        confirmations: 1,
        readyAt: 0n,
        executed: false,
        confirmed: new Set([tx.from.toLowerCase()]),
      });
      tx.logs = [
        {
          ...logBase,
          topics: encodeEventTopics({
            abi: artFiAdminSafeAbi,
            eventName: "TransactionSubmitted",
            args: {
              transactionId: BigInt(state.proposals.length),
              requestId,
              proposer: tx.from,
            },
          }),
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
            [target, value, keccak256(data)],
          ),
        },
      ];
    } else if (
      call.functionName === "confirm" ||
      call.functionName === "revoke"
    ) {
      const p = proposal(call.args[0]);
      if (call.functionName === "confirm")
        p.confirmed.add(tx.from.toLowerCase());
      else p.confirmed.delete(tx.from.toLowerCase());
      p.confirmations = p.confirmed.size;
      p.readyAt = p.confirmations >= 2 ? state.now + 60n : 0n;
    } else if (call.functionName === "execute") {
      const p = proposal(call.args[0]);
      p.executed = true;
      tx.logs = [
        {
          ...logBase,
          topics: encodeEventTopics({
            abi: artFiAdminSafeAbi,
            eventName: "TransactionExecuted",
            args: { transactionId: call.args[0], executor: tx.from },
          }),
          data: encodeAbiParameters([{ type: "bytes32" }], [zeroHash]),
        },
      ];
      if (same(p.target, safeTestAddresses.charity)) {
        const inner = decodeFunctionData({
          abi: charityEditionsAbi,
          data: p.data,
        });
        if (inner.functionName !== "createSeries")
          throw Error("TEST_ONLY expected series creation");
        state.editionCreated = true;
        const [
          artworkId,
          masterArtworkHash,
          metadataHash,
          distributionWallet,
          metadataURI,
        ] = inner.args;
        tx.logs.push({
          ...logBase,
          address: p.target,
          logIndex: "0x1",
          topics: encodeEventTopics({
            abi: charityEditionsAbi,
            eventName: "SeriesCreated",
            args: { tokenId: 1n, artworkId, masterArtworkHash },
          }),
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
            [distributionWallet, metadataHash, metadataURI],
          ),
        });
      } else {
        const innerHash = base.submit({
          to: p.target,
          from: safeTestAddresses.safe,
          data: p.data,
        });
        const receipt = base.rpc({
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [innerHash],
        });
        if (receipt.error) throw Error(receipt.error.message);
        tx.logs.push(
          ...(receipt.result as { logs: object[] }).logs.map((log) => ({
            ...log,
            transactionHash: tx.hash,
          })),
        );
      }
    } else throw Error("TEST_ONLY unsupported safe wallet method");
    tx.mined = true;
  }
  function rpc(request: { id: number; method: string; params?: unknown[] }) {
    const params = request.params ?? [];
    try {
      let result: unknown;
      if (request.method === "eth_call") {
        const input = params[0] as { to: Address; data: Hex; from?: Address };
        result = read(input.to, input.data, input.from);
      } else if (request.method === "eth_getBlockByNumber") {
        const baseResult = base.rpc(request);
        if (baseResult.error) throw Error(baseResult.error.message);
        result = {
          ...(baseResult.result as object),
          timestamp: `0x${state.now.toString(16)}`,
        };
      } else if (
        request.method === "eth_getTransactionByHash" ||
        request.method === "eth_getTransactionReceipt"
      ) {
        const tx = state.transactions.find((item) => item.hash === params[0]);
        if (!tx) result = null;
        else if (request.method === "eth_getTransactionByHash")
          result = {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            input: tx.data,
            nonce: `0x${tx.nonce.toString(16)}`,
            value: "0x0",
            gas: "0x50000",
            gasPrice: "0x1",
            blockHash: tx.mined ? blockHash : null,
            blockNumber: tx.mined ? "0x64" : null,
            transactionIndex: tx.mined ? "0x0" : null,
            type: "0x2",
            chainId: "0x88bb0",
            v: "0x0",
            r: blockHash,
            s: blockHash,
          };
        else if (state.receiptPending) result = null;
        else {
          mine(tx);
          result = {
            transactionHash: tx.hash,
            transactionIndex: "0x0",
            blockHash,
            blockNumber: "0x64",
            from: tx.from,
            to: tx.to,
            cumulativeGasUsed: "0x50000",
            gasUsed: "0x50000",
            contractAddress: null,
            logs: tx.logs,
            logsBloom: bloom,
            status: "0x1",
            effectiveGasPrice: "0x1",
            type: "0x2",
          };
        }
      } else return base.rpc(request);
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.unknownCalls.push(message);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message },
      };
    }
  }
  return { state, base, rpc, submit };
}
