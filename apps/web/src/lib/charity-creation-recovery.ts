import {
  isAddress,
  parseEventLogs,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { charityEditionsAbi } from "./contracts";
import {
  MarketReceiptFinalError,
  MarketReceiptPendingError,
} from "./market-transaction";

export type CharitySeriesFields = {
  artworkId: Hex;
  masterArtworkHash: Hex;
  metadataHash: Hex;
  distributionWallet: Address;
  metadataURI: string;
};
export type CharitySeriesResult = {
  tokenId: string;
  quantity: "100";
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
};
export type CharitySeriesFailure = {
  originalHash: Hex;
  receiptHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  outcome: "reverted" | "replaced";
};
export class CharitySeriesFinalError extends MarketReceiptFinalError {
  constructor(readonly failure: CharitySeriesFailure) {
    super(
      "The original charity-series transaction was " +
        failure.outcome +
        " in a confirmed canonical block. No series completion is claimed.",
    );
  }
}
export type CharitySeriesSetup = {
  version: 1;
  chainId: 560048;
  walletAddress: Address;
  collectionAddress: Address;
  fields: CharitySeriesFields;
  result?: CharitySeriesResult;
  lastFailure?: CharitySeriesFailure;
};
const hash = (value: unknown): value is Hex =>
  typeof value === "string" &&
  /^0x[\da-fA-F]{64}$/.test(value) &&
  value.toLowerCase() !== zeroHash;
const address = (value: unknown): value is Address =>
  typeof value === "string" &&
  isAddress(value) &&
  value.toLowerCase() !== zeroAddress;
const uint = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]{0,77})$/.test(value) &&
  BigInt(value) < 2n ** 256n;

export function isCharitySeriesFields(
  value: unknown,
): value is CharitySeriesFields {
  if (!value || typeof value !== "object") return false;
  const f = value as CharitySeriesFields;
  return (
    hash(f.artworkId) &&
    hash(f.masterArtworkHash) &&
    hash(f.metadataHash) &&
    address(f.distributionWallet) &&
    typeof f.metadataURI === "string" &&
    new TextEncoder().encode(f.metadataURI).byteLength <= 512 &&
    (f.metadataURI.startsWith("ipfs://") ||
      f.metadataURI.startsWith("https://"))
  );
}
export function isCharitySeriesSetup(
  value: unknown,
): value is CharitySeriesSetup {
  if (!value || typeof value !== "object") return false;
  const s = value as CharitySeriesSetup;
  if (
    s.version !== 1 ||
    s.chainId !== 560048 ||
    !address(s.walletAddress) ||
    !address(s.collectionAddress) ||
    !isCharitySeriesFields(s.fields)
  )
    return false;
  const failure = s.lastFailure;
  if (
    failure !== undefined &&
    (!failure ||
      typeof failure !== "object" ||
      !hash(failure.originalHash) ||
      !hash(failure.receiptHash) ||
      !uint(failure.blockNumber) ||
      !hash(failure.blockHash) ||
      (failure.outcome !== "reverted" && failure.outcome !== "replaced"))
  )
    return false;
  const r = s.result;
  return (
    r === undefined ||
    (r !== null &&
      typeof r === "object" &&
      uint(r.tokenId) &&
      r.tokenId !== "0" &&
      r.quantity === "100" &&
      hash(r.transactionHash) &&
      uint(r.blockNumber) &&
      hash(r.blockHash))
  );
}
export function sameCharitySeriesFields(
  a: CharitySeriesFields,
  b: CharitySeriesFields,
) {
  return (
    a.artworkId.toLowerCase() === b.artworkId.toLowerCase() &&
    a.masterArtworkHash.toLowerCase() === b.masterArtworkHash.toLowerCase() &&
    a.metadataHash.toLowerCase() === b.metadataHash.toLowerCase() &&
    a.distributionWallet.toLowerCase() === b.distributionWallet.toLowerCase() &&
    a.metadataURI === b.metadataURI
  );
}
type Reader = Pick<
  PublicClient,
  "waitForTransactionReceipt" | "readContract" | "getChainId" | "getBlock"
>;
export const charityCreationReadTimeoutMs = 15000;

/** Read-only proof. A timeout retires this result; it does not cancel or replay a transaction. */
export async function readCharitySeriesCreation(
  client: Reader,
  setup: CharitySeriesSetup,
  submittedHash: Hex,
  assertCurrent: () => void,
  onRepriced: (hash: Hex) => void = () => {},
): Promise<CharitySeriesResult> {
  if (!isCharitySeriesSetup(setup) || !hash(submittedHash))
    throw Error("The saved charity-series bindings are invalid.");
  let retired = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    expectedHash = submittedHash;
  const current = () => {
    if (retired) throw Error("The charity-series read is no longer active.");
    assertCurrent();
  };
  const work = async (): Promise<CharitySeriesResult> => {
    current();
    let replaced = false,
      observedHash = submittedHash;
    let receipt: Awaited<ReturnType<Reader["waitForTransactionReceipt"]>>;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash: submittedHash,
        onReplaced(replacement) {
          if (retired) return;
          current();
          const next = replacement.transactionReceipt.transactionHash;
          if (!hash(next))
            throw Error(
              "The replacement receipt hash is invalid; the original request remains unresolved.",
            );
          observedHash = next;
          if (replacement.reason === "repriced") {
            expectedHash = next;
            onRepriced(next);
          } else replaced = true;
        },
      });
    } catch {
      throw new MarketReceiptPendingError();
    }
    current();
    if (
      receipt.transactionHash.toLowerCase() !== observedHash.toLowerCase() ||
      !hash(receipt.blockHash) ||
      typeof receipt.blockNumber !== "bigint" ||
      receipt.blockNumber < 0n
    )
      throw Error(
        "The charity receipt does not match the saved transaction and mined block.",
      );
    const canonical = async () => {
      const [chain, block] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      current();
      if (
        chain !== setup.chainId ||
        block.number !== receipt.blockNumber ||
        block.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
      )
        throw Error(
          "The charity receipt block or chain changed. Reconcile the original transaction before continuing.",
        );
    };
    await canonical();
    if (replaced || receipt.status === "reverted") {
      await canonical();
      throw new CharitySeriesFinalError({
        originalHash: submittedHash,
        receiptHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        outcome: replaced ? "replaced" : "reverted",
      });
    }
    if (receipt.status !== "success")
      throw Error("The charity receipt outcome remains unresolved.");
    const f = setup.fields;
    const created = parseEventLogs({
      abi: charityEditionsAbi,
      eventName: "SeriesCreated",
      logs: receipt.logs.filter(
        (log) =>
          log.address.toLowerCase() === setup.collectionAddress.toLowerCase(),
      ),
      strict: true,
    }).find(
      (log) =>
        log.args.artworkId.toLowerCase() === f.artworkId.toLowerCase() &&
        log.args.masterArtworkHash.toLowerCase() ===
          f.masterArtworkHash.toLowerCase() &&
        log.args.metadataHash.toLowerCase() === f.metadataHash.toLowerCase() &&
        log.args.distributionWallet.toLowerCase() ===
          f.distributionWallet.toLowerCase() &&
        log.args.metadataURI === f.metadataURI,
    );
    if (!created || created.args.tokenId <= 0n)
      throw Error("The confirmed series event is missing or mismatched.");
    const [supply, balance] = await Promise.all([
      client.readContract({
        abi: charityEditionsAbi,
        address: setup.collectionAddress,
        functionName: "totalSupply",
        args: [created.args.tokenId],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        abi: charityEditionsAbi,
        address: setup.collectionAddress,
        functionName: "balanceOf",
        args: [f.distributionWallet, created.args.tokenId],
        blockNumber: receipt.blockNumber,
      }),
    ]);
    current();
    if (supply !== 100n || balance !== 100n)
      throw Error(
        "The confirmed series does not hold the required 100 units at its receipt block.",
      );
    await canonical();
    current();
    return {
      tokenId: created.args.tokenId.toString(),
      quantity: "100",
      transactionHash: expectedHash,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    };
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          retired = true;
          reject(
            Error(
              "The charity receipt check timed out. Its original request remains unresolved; check it before another submission.",
            ),
          );
        }, charityCreationReadTimeoutMs);
      }),
    ]);
  } finally {
    retired = true;
    clearTimeout(timer);
  }
}

/** Simulation is read-only and cannot authorize or send a wallet request. */
export async function simulateCharitySeriesCreation(
  client: Pick<PublicClient, "simulateContract">,
  setup: CharitySeriesSetup,
  assertCurrent: () => void,
  caller: Address = setup.walletAddress,
) {
  if (!isCharitySeriesSetup(setup) || !address(caller))
    throw Error("The reviewed charity-series bindings are invalid.");
  assertCurrent();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const f = setup.fields;
    await Promise.race([
      client.simulateContract({
        abi: charityEditionsAbi,
        address: setup.collectionAddress,
        account: caller,
        functionName: "createSeries",
        args: [
          f.artworkId,
          f.masterArtworkHash,
          f.metadataHash,
          f.distributionWallet,
          f.metadataURI,
        ],
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                "The charity-series simulation timed out. No wallet request was made.",
              ),
            ),
          charityCreationReadTimeoutMs,
        );
      }),
    ]);
    assertCurrent();
  } finally {
    clearTimeout(timer);
  }
}
