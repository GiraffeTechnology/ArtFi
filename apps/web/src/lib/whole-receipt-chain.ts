import "server-only";
import {
  decodeEventLog,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  receiptAuthorizationHash,
  type ReceiptCorrespondence,
} from "./whole-receipt-authorization";
import type { SaleIntent, SaleIntentDomain } from "./whole-artwork-intent";
import type { VerifiedReceiptEvent } from "./whole-receipt-reader";

export const wholeReceiptEvents = parseAbi([
  "event ReceiptFunded(bytes32 indexed segmentId,address indexed seller,address indexed buyer,address collection,uint256 tokenId,address paymentToken,uint256 amount,bytes32 settlementId,bytes32 requestHash,bytes32 executionReferenceHash,bytes32 previousSegment)",
  "event ReceiptSellerPaid(bytes32 indexed segmentId,address indexed seller,address token,uint256 amount)",
  "event ReceiptRegistrationConfirmed(bytes32 indexed segmentId,bytes32 indexed recordHash)",
]);
const erc20Transfer = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const erc721Transfer = parseAbi([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

export type ReceiptChainLog = {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  removed: boolean;
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  logIndex: number;
};
export type ReceiptChainReceipt = {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  logs: readonly ReceiptChainLog[];
};
/** Compose with the existing server-owned RPC client. No browser URL, provider,
 * arbitrary receipt or client-reported finality can satisfy this interface.
 * An approved deployment manifest must supply the exact immutable runtime hash.
 */
export interface WholeReceiptChainClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(input: { hash: Hex }): Promise<ReceiptChainReceipt>;
  getTransaction(input: { hash: Hex }): Promise<{
    hash: Hex;
    blockHash: Hex | null;
    blockNumber: bigint | null;
    from: Address;
    to: Address | null;
    value: bigint;
  }>;
  getBlock(input: {
    blockNumber: bigint;
  }): Promise<{ hash: Hex | null; number: bigint }>;
  getBlockNumber(): Promise<bigint>;
  getCode(input: {
    address: Address;
    blockNumber: bigint;
  }): Promise<Hex | undefined>;
}
type JournalTrade = {
  sale: SaleIntent;
  domain: SaleIntentDomain;
  correspondence: ReceiptCorrespondence;
};
/** Canonical contract observation, not an independently authenticated Oracle fact. */
export type ReceiptRegistrationObservation = {
  kind: "registration-confirmed-onchain";
  segmentId: Hex;
  recordHash: Hex;
  reference: string;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  oracleEvidenceAuthenticated: false;
};
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const refuse = (): never => {
  throw Error("RECEIPT_CHAIN_EVIDENCE_INVALID");
};
function one<T>(items: T[]): T {
  if (items.length !== 1) refuse();
  return items[0];
}
function reference(chain: number, log: ReceiptChainLog) {
  return `${chain}:${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${log.logIndex}`;
}

/** Read-only chain association for an already-authenticated journal trade.
 * Funding/payout events emitted by the exact reviewed escrow implementation prove
 * its checked exact debit/credit behavior; matching token logs are additionally
 * required. This does not authenticate an Oracle record or grant execution.
 * A canonicality failure returns no event; callers must reconcile, not retry a
 * financial transaction. Never compare a historical segment with ownerOf(latest).
 */
function createWholeReceiptReaders(config: {
  client: WholeReceiptChainClient;
  chainId: number;
  escrow: Address;
  runtimeCodeHash: Hex;
  confirmations: number;
}) {
  if (
    ![31337, 560048].includes(config.chainId) ||
    !/^0x[0-9a-fA-F]{40}$/.test(config.escrow) ||
    /^0x0{40}$/i.test(config.escrow) ||
    !hex32.test(config.runtimeCodeHash) ||
    /^0x0{64}$/i.test(config.runtimeCodeHash) ||
    !Number.isSafeInteger(config.confirmations) ||
    config.confirmations < 2
  )
    refuse();
  const { client, chainId, escrow, runtimeCodeHash, confirmations } = config;
  const read = async (
    kind: "funded" | "paid" | "registered",
    rawTrade: JournalTrade,
    hash: Hex,
  ): Promise<VerifiedReceiptEvent | ReceiptRegistrationObservation> => {
    // Snapshot before the first await: no journal mutation can change correspondence.
    const trade = structuredClone(rawTrade);
    if (
      !["funded", "paid", "registered"].includes(kind) ||
      !hex32.test(hash) ||
      trade.domain.chainId !== chainId ||
      !equal(trade.domain.verifyingContract, escrow)
    )
      refuse();
    const segmentId = receiptAuthorizationHash(
      trade.sale,
      trade.domain,
      trade.correspondence,
    );
    const { sale, correspondence: c } = trade;
    if ((await client.getChainId()) !== chainId) refuse();
    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash }),
      client.getTransaction({ hash }),
    ]);
    if (
      receipt.status !== "success" ||
      !equal(receipt.transactionHash, hash) ||
      !hex32.test(receipt.blockHash) ||
      receipt.blockNumber < 0n ||
      !equal(tx.hash, hash) ||
      tx.blockNumber !== receipt.blockNumber ||
      !tx.blockHash ||
      !equal(tx.blockHash, receipt.blockHash) ||
      !tx.to ||
      !equal(tx.to, escrow) ||
      tx.value !== 0n ||
      (kind === "funded" && !equal(tx.from, sale.buyer))
    )
      refuse();
    const [block, height, code] = await Promise.all([
      client.getBlock({ blockNumber: receipt.blockNumber }),
      client.getBlockNumber(),
      client.getCode({ address: escrow, blockNumber: receipt.blockNumber }),
    ]);
    if (
      block.number !== receipt.blockNumber ||
      !block.hash ||
      !equal(block.hash, receipt.blockHash) ||
      height - receipt.blockNumber + 1n < BigInt(confirmations) ||
      !code ||
      code === "0x" ||
      !equal(keccak256(code), runtimeCodeHash)
    )
      refuse();
    const indices = new Set<number>();
    for (const log of receipt.logs) {
      if (
        log.removed !== false ||
        log.blockNumber !== receipt.blockNumber ||
        !equal(log.blockHash, receipt.blockHash) ||
        !equal(log.transactionHash, hash) ||
        !Number.isSafeInteger(log.logIndex) ||
        log.logIndex < 0 ||
        indices.has(log.logIndex)
      )
        refuse();
      indices.add(log.logIndex);
    }
    const expectedName =
      kind === "funded" ? "ReceiptFunded" : kind === "paid" ? "ReceiptSellerPaid" : "ReceiptRegistrationConfirmed";
    const events = receipt.logs.flatMap((log) => {
      if (!equal(log.address, escrow)) return [];
      try {
        const event = decodeEventLog({
          abi: wholeReceiptEvents,
          data: log.data,
          topics: log.topics as [Hex, ...Hex[]],
          strict: true,
        });
        return event.eventName === expectedName ? [{ log, event }] : [];
      } catch {
        return [];
      }
    });
    const selected = one(events);
    const recheck = async () => {
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (block.number !== receipt.blockNumber || !block.hash || !equal(block.hash, receipt.blockHash)) refuse();
    };
    if (selected.event.eventName === "ReceiptRegistrationConfirmed") {
      const a = selected.event.args;
      if (!equal(a.segmentId, segmentId) || !hex32.test(a.recordHash) || /^0x0{64}$/i.test(a.recordHash)) refuse();
      await recheck();
      return {
        kind: "registration-confirmed-onchain",
        segmentId,
        recordHash: a.recordHash,
        reference: reference(chainId, selected.log),
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionHash: receipt.transactionHash,
        oracleEvidenceAuthenticated: false,
      };
    }
    const args = selected.event.args;
    if (
      !equal(args.segmentId, segmentId) ||
      !equal(args.seller, sale.seller) ||
      args.amount !== sale.price
    )
      refuse();
    const payment = one(
      receipt.logs.flatMap((log) => {
        if (!equal(log.address, sale.paymentToken)) return [];
        try {
          const { args } = decodeEventLog({
            abi: erc20Transfer,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
            strict: true,
          });
          return equal(args.from, kind === "funded" ? sale.buyer : escrow) &&
            equal(args.to, kind === "funded" ? escrow : sale.seller) &&
            args.value === sale.price
            ? [log]
            : [];
        } catch {
          return [];
        }
      }),
    );
    if (payment.logIndex >= selected.log.logIndex) refuse();
    let result: VerifiedReceiptEvent;
    if (selected.event.eventName === "ReceiptFunded") {
      const a = selected.event.args;
      if (
        !equal(a.buyer, sale.buyer) ||
        !equal(a.collection, sale.collection) ||
        a.tokenId !== sale.tokenId ||
        !equal(a.paymentToken, sale.paymentToken) ||
        !equal(a.settlementId, c.settlementId) ||
        !equal(a.requestHash, c.requestHash) ||
        !equal(a.executionReferenceHash, c.executionReferenceHash) ||
        !equal(a.previousSegment, c.previousSegment)
      )
        refuse();
      const nft = one(
        receipt.logs.flatMap((log) => {
          if (!equal(log.address, sale.collection)) return [];
          try {
            const { args } = decodeEventLog({
              abi: erc721Transfer,
              data: log.data,
              topics: log.topics as [Hex, ...Hex[]],
              strict: true,
            });
            return equal(args.from, sale.seller) &&
              equal(args.to, sale.buyer) &&
              args.tokenId === sale.tokenId
              ? [log]
              : [];
          } catch {
            return [];
          }
        }),
      );
      if (
        nft.logIndex <= payment.logIndex ||
        nft.logIndex >= selected.log.logIndex
      )
        refuse();
      result = {
        kind: "funded",
        trade: {
          id: segmentId,
          seller: sale.seller,
          buyer: sale.buyer,
          paymentToken: sale.paymentToken,
          amount: sale.price,
          escrowReference: reference(chainId, selected.log),
          ownerTransferReference: reference(chainId, nft),
        },
      };
    } else {
      if (!equal(selected.event.args.token, sale.paymentToken)) refuse();
      result = {
        kind: "paid",
        segmentId,
        reference: reference(chainId, selected.log),
      };
    }
    // Recheck after all reads/decoding to reject a reorg during reconciliation.
    await recheck();
    return result;
  };
  // Preserve the existing funding/payment call signature. The separate method's
  // result cannot be consumed as a trusted registration event by the UI ledger.
  return Object.assign(
    (kind: "funded" | "paid", trade: JournalTrade, hash: Hex) =>
      read(kind, trade, hash) as Promise<VerifiedReceiptEvent>,
    { readRegistration: (trade: JournalTrade, hash: Hex) =>
      read("registered", trade, hash) as Promise<ReceiptRegistrationObservation> },
  );
}

export function createWholeReceiptChainReader(config: Parameters<typeof createWholeReceiptReaders>[0]) {
  const reader = createWholeReceiptReaders(config);
  return (kind: "funded" | "paid", trade: JournalTrade, hash: Hex) => reader(kind, trade, hash);
}

/** Does not produce a trusted ledger event or authorize any journal transition. */
export function createWholeReceiptRegistrationReader(config: Parameters<typeof createWholeReceiptReaders>[0]) {
  return createWholeReceiptReaders(config).readRegistration;
}
