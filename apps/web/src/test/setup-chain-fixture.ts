import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  multicall3Abi,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import {
  artFiVaultAbi,
  erc721VaultApprovalAbi,
  rwaRegistryAbi,
  vaultFactoryAbi,
} from "../lib/contracts";

// TEST_ONLY public identities. Every RPC result is produced locally by Playwright;
// none of these values describe a deployed contract or a real asset.
export const setupAddresses = {
  wallet: "0x1000000000000000000000000000000000000010",
  otherWallet: "0x1000000000000000000000000000000000000020",
  registry: "0x1000000000000000000000000000000000000007",
  collection: "0x1000000000000000000000000000000000000002",
  factory: "0x1000000000000000000000000000000000000008",
  vault: "0x1000000000000000000000000000000000000009",
  fraction: "0x1000000000000000000000000000000000000004",
} as const;
export const setupRequestIds = {
  mint: `0x${"71".repeat(32)}` as Hex,
  vault: `0x${"72".repeat(32)}` as Hex,
};
export const setupMetadataHash = `0x${"73".repeat(32)}` as Hex;
export const setupMetadataUri = "ipfs://TEST_ONLY-setup-recovery-metadata";
const blockHash = `0x${"74".repeat(32)}` as Hex;
const bloom = `0x${"00".repeat(256)}`;

export type SetupAction = "mint" | "create" | "approve" | "deposit" | "issue";
export type SetupOutcome = "pending" | "success" | "reverted";
export type SetupTransaction = {
  to: Address;
  data: Hex;
  from: Address;
  hash: Hex;
  action: SetupAction;
  nonce: number;
};

// Getter definitions below mirror existing Solidity interfaces. Keeping this test
// ABI explicit lets the fixture reject unknown calls instead of silently succeeding.
const readAbi = parseAbi([
  "function assetByRequest(bytes32) view returns ((address creator,address recipient,uint256 tokenId,bytes32 metadataHash,bytes32 intentHash,uint64 createdAt,string metadataURI))",
  "function nft() view returns (address)",
  "function vaultForRequest(bytes32) view returns (address)",
  "function vaultByAsset(bytes32) view returns (address)",
  "function collection() view returns (address)",
  "function tokenId() view returns (uint256)",
  "function tokenAdmin() view returns (address)",
  "function vaultName() view returns (string)",
  "function originalOwner() view returns (address)",
  "function fractionalToken() view returns (address)",
  "function fractionalSupply() view returns (uint256)",
  "function deposited() view returns (bool)",
  "function ownerOf(uint256) view returns (address)",
  "function getApproved(uint256) view returns (address)",
  "function paused() view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function CREATOR_ROLE() view returns (bytes32)",
  "function REGISTRAR_ROLE() view returns (bytes32)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function FRACTIONALIZER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function getEthBalance(address) view returns (uint256)",
]);

export function createSetupChainFixture() {
  const state = {
    transactions: [] as SetupTransaction[],
    outcomes: {
      mint: "success",
      create: "success",
      approve: "success",
      deposit: "success",
      issue: "success",
    } as Record<SetupAction, SetupOutcome>,
    noCreationEvents: false,
    owner: setupAddresses.wallet as Address,
    block: 100,
    minted: false,
    created: false,
    approved: false,
    deposited: false,
    issued: false,
    unknownCalls: [] as string[],
  };
  const writeAbi = [
    ...rwaRegistryAbi,
    ...vaultFactoryAbi,
    ...erc721VaultApprovalAbi,
    ...artFiVaultAbi,
  ] as const;
  function decode(transaction: Pick<SetupTransaction, "data">) {
    return decodeFunctionData({ abi: writeAbi, data: transaction.data });
  }
  function actionFor(data: Hex): SetupAction {
    const call = decode({ data });
    switch (call.functionName) {
      case "createAsset":
        return "mint";
      case "createVault":
        return "create";
      case "approve":
        return "approve";
      case "deposit":
        return "deposit";
      case "fractionalize":
        return "issue";
      default:
        throw new Error(`Unsupported TEST_ONLY write: ${call.functionName}`);
    }
  }
  function submit(input: { to: Address; data: Hex; from?: Address }) {
    const nonce = state.transactions.length;
    const hash = `0x${(nonce + 1).toString(16).padStart(64, "0")}` as Hex;
    state.transactions.push({
      ...input,
      from: input.from ?? setupAddresses.wallet,
      hash,
      nonce,
      action: actionFor(input.data),
    });
    return hash;
  }
  function latest(action: SetupAction) {
    return state.transactions.findLast((entry) => entry.action === action);
  }
  function markMined(transaction: SetupTransaction) {
    if (state.outcomes[transaction.action] !== "success") return;
    if (transaction.action === "mint") state.minted = true;
    if (transaction.action === "create") state.created = true;
    if (transaction.action === "approve") state.approved = true;
    if (transaction.action === "deposit") {
      state.deposited = true;
      state.owner = setupAddresses.vault;
    }
    if (transaction.action === "issue") state.issued = true;
  }
  function read(data: Hex, target?: Address): Hex {
    if (
      data.startsWith(toFunctionSelector("aggregate3((address,bool,bytes)[])"))
    ) {
      const call = decodeFunctionData({ abi: multicall3Abi, data });
      if (call.functionName !== "aggregate3")
        throw new Error("Unsupported multicall");
      return encodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        result: call.args[0].map((entry) => {
          try {
            return {
              success: true,
              returnData: read(entry.callData, entry.target),
            };
          } catch {
            return { success: false, returnData: "0x" as Hex };
          }
        }),
      });
    }
    const call = decodeFunctionData({ abi: readAbi, data });
    const create = latest("create");
    const vaultCall = create ? decode(create) : undefined;
    const issuance = latest("issue");
    const issueCall = issuance ? decode(issuance) : undefined;
    const vaultName =
      vaultCall?.functionName === "createVault"
        ? vaultCall.args[1]
        : "TEST_ONLY Recovery DAO";
    const supply =
      issueCall?.functionName === "fractionalize"
        ? issueCall.args[2]
        : 100n * 10n ** 18n;
    const encode = (
      type: "address" | "bytes32" | "string" | "bool" | "uint256" | "uint8",
      value: Address | Hex | string | boolean | bigint | number,
    ) => encodeAbiParameters([{ type }], [value]);
    switch (call.functionName) {
      case "assetByRequest": {
        const transaction = latest("mint");
        if (!state.minted || !transaction)
          throw new Error("TEST_ONLY UnknownRequest");
        const mint = decode(transaction);
        if (
          mint.functionName !== "createAsset" ||
          call.args[0] !== mint.args[0]
        )
          throw new Error("TEST_ONLY wrong mint request");
        return encodeFunctionResult({
          abi: readAbi,
          functionName: "assetByRequest",
          result: {
            creator: transaction.from,
            recipient: mint.args[1],
            tokenId: 1n,
            metadataHash: mint.args[3],
            intentHash: keccak256(
              encodeAbiParameters(
                [{ type: "address" }, { type: "string" }, { type: "bytes32" }],
                [mint.args[1], mint.args[2], mint.args[3]],
              ),
            ),
            createdAt: 1760000000n,
            metadataURI: mint.args[2],
          },
        });
      }
      case "nft":
      case "collection":
        return encode("address", setupAddresses.collection);
      case "vaultForRequest":
        return encode(
          "address",
          state.created &&
            vaultCall?.functionName === "createVault" &&
            call.args[0] === vaultCall.args[0]
            ? setupAddresses.vault
            : zeroAddress,
        );
      case "vaultByAsset":
        return encode(
          "address",
          state.created ? setupAddresses.vault : zeroAddress,
        );
      case "tokenId":
        return encode("uint256", 1n);
      case "tokenAdmin":
        return encode("address", setupAddresses.wallet);
      case "vaultName":
        return encode("string", vaultName);
      case "originalOwner":
        return encode(
          "address",
          state.deposited ? setupAddresses.wallet : zeroAddress,
        );
      case "fractionalToken":
        return encode(
          "address",
          state.issued ? setupAddresses.fraction : zeroAddress,
        );
      case "fractionalSupply":
        return encode("uint256", state.issued ? supply : 0n);
      case "deposited":
        return encode("bool", state.deposited);
      case "ownerOf":
        return encode(
          "address",
          call.args[0] === 1n ? state.owner : setupAddresses.wallet,
        );
      case "getApproved":
        return encode(
          "address",
          state.approved ? setupAddresses.vault : zeroAddress,
        );
      case "paused":
        return encode("bool", false);
      case "hasRole": {
        const fractionalizerRole = keccak256(
          new TextEncoder().encode("FRACTIONALIZER_ROLE"),
        );
        const roleWallet =
          target?.toLowerCase() === setupAddresses.vault.toLowerCase() &&
          call.args[0] === fractionalizerRole &&
          vaultCall?.functionName === "createVault"
            ? vaultCall.args[6]
            : setupAddresses.wallet;
        return encode(
          "bool",
          call.args[1].toLowerCase() === roleWallet.toLowerCase(),
        );
      }
      case "DEFAULT_ADMIN_ROLE":
        return encode("bytes32", zeroHash);
      case "CREATOR_ROLE":
      case "REGISTRAR_ROLE":
      case "PAUSER_ROLE":
      case "FRACTIONALIZER_ROLE":
        return encode(
          "bytes32",
          keccak256(new TextEncoder().encode(call.functionName)),
        );
      case "name":
        return encode(
          "string",
          issueCall?.functionName === "fractionalize"
            ? issueCall.args[0]
            : "TEST_ONLY Fractions",
        );
      case "symbol":
        return encode(
          "string",
          issueCall?.functionName === "fractionalize"
            ? issueCall.args[1]
            : "TEST",
        );
      case "totalSupply":
        return encode("uint256", supply);
      case "balanceOf":
        return encode(
          "uint256",
          state.issued &&
            target?.toLowerCase() === setupAddresses.fraction.toLowerCase()
            ? supply
            : 0n,
        );
      case "decimals":
        return encode("uint8", 18);
      case "getEthBalance":
        return encode("uint256", 10n ** 18n);
    }
  }
  function logs(transaction: SetupTransaction) {
    const call = decode(transaction);
    const base = {
      blockHash,
      blockNumber: "0x64",
      transactionHash: transaction.hash,
      transactionIndex: "0x0",
      logIndex: "0x0",
      removed: false,
    };
    if (
      state.noCreationEvents &&
      ["mint", "create"].includes(transaction.action)
    )
      return [];
    if (call.functionName === "createAsset")
      return [
        {
          ...base,
          address: setupAddresses.registry,
          topics: encodeEventTopics({
            abi: rwaRegistryAbi,
            eventName: "AssetCreated",
            args: {
              requestId: call.args[0],
              tokenId: 1n,
              recipient: call.args[1],
            },
          }),
          data: encodeAbiParameters(
            [{ type: "address" }, { type: "bytes32" }, { type: "string" }],
            [transaction.from, call.args[3], call.args[2]],
          ),
        },
      ];
    if (call.functionName === "createVault")
      return [
        {
          ...base,
          address: setupAddresses.factory,
          topics: encodeEventTopics({
            abi: vaultFactoryAbi,
            eventName: "VaultCreated",
            args: {
              requestId: call.args[0],
              vault: setupAddresses.vault,
              collection: call.args[2],
            },
          }),
          data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "string" }],
            [call.args[3], call.args[1]],
          ),
        },
      ];
    if (call.functionName === "deposit")
      return [
        {
          ...base,
          address: setupAddresses.vault,
          topics: encodeEventTopics({
            abi: artFiVaultAbi,
            eventName: "NFTDeposited",
            args: {
              collection: setupAddresses.collection,
              tokenId: 1n,
              owner: transaction.from,
            },
          }),
          data: "0x",
        },
      ];
    if (call.functionName === "fractionalize")
      return [
        {
          ...base,
          address: setupAddresses.vault,
          topics: encodeEventTopics({
            abi: artFiVaultAbi,
            eventName: "Fractionalized",
            args: { token: setupAddresses.fraction, recipient: call.args[3] },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [call.args[2]]),
        },
      ];
    return [];
  }
  function transaction(hash: Hex) {
    const entry = state.transactions.find((item) => item.hash === hash);
    if (!entry) return null;
    return {
      hash,
      from: entry.from,
      to: entry.to,
      input: entry.data,
      nonce: `0x${entry.nonce.toString(16)}`,
      value: "0x0",
      gas: "0x5208",
      gasPrice: "0x1",
      blockHash: null,
      blockNumber: null,
      transactionIndex: null,
      type: "0x2",
      chainId: "0x88bb0",
      v: "0x0",
      r: blockHash,
      s: blockHash,
    };
  }
  function rpc(request: { id: number; method: string; params?: unknown[] }) {
    const params = request.params ?? [];
    let result: unknown;
    try {
      switch (request.method) {
        case "eth_chainId":
          result = "0x88bb0";
          break;
        case "eth_blockNumber":
          result = `0x${(state.block++).toString(16)}`;
          break;
        case "eth_getBalance":
          result = "0xde0b6b3a7640000";
          break;
        case "eth_getCode":
          result = "0x6000";
          break;
        case "eth_call": {
          const input = params[0] as { data: Hex; to: Address };
          result = read(input.data, input.to);
          break;
        }
        case "eth_getTransactionByHash":
          result = transaction(params[0] as Hex);
          break;
        case "eth_getTransactionCount":
          result = `0x${state.transactions.length.toString(16)}`;
          break;
        case "eth_getTransactionReceipt": {
          const entry = state.transactions.find(
            (item) => item.hash === params[0],
          );
          if (!entry || state.outcomes[entry.action] === "pending") {
            result = null;
            break;
          }
          markMined(entry);
          result = {
            transactionHash: entry.hash,
            transactionIndex: "0x0",
            blockHash,
            blockNumber: "0x64",
            from: entry.from,
            to: entry.to,
            cumulativeGasUsed: "0x5208",
            gasUsed: "0x5208",
            contractAddress: null,
            logs: state.outcomes[entry.action] === "success" ? logs(entry) : [],
            logsBloom: bloom,
            status: state.outcomes[entry.action] === "success" ? "0x1" : "0x0",
            effectiveGasPrice: "0x1",
            type: "0x2",
          };
          break;
        }
        case "eth_getBlockByNumber":
          result = {
            number: `0x${state.block.toString(16)}`,
            hash: blockHash,
            parentHash: blockHash,
            transactions: [],
            gasLimit: "0x1000000",
            gasUsed: "0x0",
            timestamp: "0x68b00000",
            extraData: "0x",
            difficulty: "0x0",
            totalDifficulty: "0x0",
            size: "0x1",
            uncles: [],
            miner: zeroAddress,
            nonce: "0x0000000000000000",
            mixHash: blockHash,
            receiptsRoot: blockHash,
            stateRoot: blockHash,
            transactionsRoot: blockHash,
            sha3Uncles: blockHash,
            logsBloom: bloom,
            baseFeePerGas: "0x1",
          };
          break;
        default:
          throw new Error(`Unsupported TEST_ONLY RPC: ${request.method}`);
      }
      return { jsonrpc: "2.0", id: request.id, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("UnknownRequest")) state.unknownCalls.push(message);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message },
      };
    }
  }
  return { state, submit, rpc, actionFor };
}
