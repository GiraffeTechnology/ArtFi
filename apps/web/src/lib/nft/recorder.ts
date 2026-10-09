import "server-only";
import {
  AbstractSigner,
  JsonRpcProvider,
  resolveProperties,
  type Provider,
  type JsonRpcPayload,
  type TransactionRequest,
  type TransactionResponse,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import type { Address, Hex } from "viem";
import { NftError, type NftTransaction, type NftTypedData } from "./model";

const reads = new Set([
  "eth_chainId",
  "eth_call",
  "eth_getCode",
  "eth_getBalance",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getLogs",
]);
/** The SDK receives a read-only RPC provider even if an upstream RPC has unlocked accounts. */
export class ReadOnlyNftProvider extends JsonRpcProvider {
  override async send(
    method: string,
    params: Array<unknown> | Record<string, unknown>,
  ): Promise<unknown> {
    if (!reads.has(method))
      throw new NftError(403, "Server-side wallet execution is prohibited.");
    return super.send(method, params);
  }
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]) {
    if (
      (Array.isArray(payload) ? payload : [payload]).some(
        (item) => !reads.has(item.method),
      )
    )
      throw new NftError(403, "Server-side wallet execution is prohibited.");
    return super._send(payload);
  }
  override async broadcastTransaction(): Promise<TransactionResponse> {
    throw new NftError(403, "Server-side wallet execution is prohibited.");
  }
}
/** No key material. The first requested wallet action is captured and execution is stopped. */
export class NftPlanRecorder extends AbstractSigner {
  readonly address: Address;
  captured?: { transaction: NftTransaction } | { typedData: NftTypedData };
  constructor(address: Address, provider: Provider | null) {
    super(provider);
    this.address = address;
  }
  getAddress() {
    return Promise.resolve(this.address);
  }
  connect(provider: Provider | null) {
    return new NftPlanRecorder(this.address, provider);
  }
  async signMessage(): Promise<string> {
    throw new NftError(403, "Server-side signing is prohibited.");
  }
  async signTransaction(): Promise<string> {
    throw new NftError(403, "Server-side signing is prohibited.");
  }
  override async sendTransaction(
    transaction: TransactionRequest,
  ): Promise<TransactionResponse> {
    if (this.captured)
      throw new NftError(409, "A wallet action is already awaiting review.");
    const tx = await resolveProperties(transaction);
    if (
      typeof tx.to !== "string" ||
      typeof tx.data !== "string" ||
      (tx.from && String(tx.from).toLowerCase() !== this.address.toLowerCase())
    )
      throw new NftError(422, "The venue returned an invalid wallet request.");
    this.captured = {
      transaction: {
        to: tx.to as Address,
        data: tx.data as Hex,
        value: BigInt(tx.value || 0).toString(),
      },
    };
    throw new NftError(409, "Wallet review required.");
  }
  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
  ): Promise<string> {
    if (this.captured)
      throw new NftError(409, "A wallet action is already awaiting review.");
    // JSON conversion rejects cyclic data; bigint is represented losslessly.
    const typedData = JSON.parse(
      JSON.stringify(
        { domain, types, message: value, primaryType: "OrderComponents" },
        (_, item) => (typeof item === "bigint" ? item.toString() : item),
      ),
    ) as NftTypedData;
    typedData.domain.chainId = Number(typedData.domain.chainId);
    this.captured = { typedData };
    throw new NftError(409, "Wallet review required.");
  }
}
