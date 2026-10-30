import {
  encodeFunctionData,
  zeroHash,
  type Hex,
  type PublicClient,
} from "viem";
import {
  MarketReceiptFinalError,
  MarketReceiptPendingError,
} from "./market-transaction";
import {
  charityEvidenceCall,
  prepareCharityEvidence,
  verifyCharityEvidenceReceipt,
  verifyDirectCharityEvidenceTransaction,
  type CharityEvidenceRecord,
  type CharityEvidenceOutcome,
} from "./charity-evidence";

export const charityEvidenceReadTimeoutMs = 15000;
const hash = (v: unknown): v is Hex =>
  typeof v === "string" &&
  /^0x[0-9a-fA-F]{64}$/.test(v) &&
  v.toLowerCase() !== zeroHash;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export class CharityEvidenceFinalError extends MarketReceiptFinalError {
  constructor(readonly outcome: CharityEvidenceOutcome) {
    super(
      "The original evidence transaction was " +
        outcome.status +
        " in a confirmed canonical block. No charity evidence completion is claimed.",
    );
  }
}

/** Retire late read results; a timeout never cancels, resends or frees a transaction. */
export async function charityEvidenceRead<T>(
  assertCurrent: () => void,
  work: (current: () => void) => Promise<T>,
): Promise<T> {
  let retired = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => {
    if (retired) throw Error("The evidence read is no longer active.");
    assertCurrent();
  };
  try {
    current();
    return await Promise.race([
      work(current),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          retired = true;
          reject(
            Error(
              "The evidence check timed out. Reconcile its original request before another submission.",
            ),
          );
        }, charityEvidenceReadTimeoutMs);
      }),
    ]);
  } finally {
    retired = true;
    clearTimeout(timer);
  }
}

export function prepareCharityEvidenceForView(
  client: Parameters<typeof prepareCharityEvidence>[0],
  record: CharityEvidenceRecord,
  safe: Parameters<typeof prepareCharityEvidence>[2],
  assertCurrent: () => void,
) {
  return charityEvidenceRead(assertCurrent, (current) =>
    prepareCharityEvidence(client, record, safe, current),
  );
}

type Reader = Pick<
  PublicClient,
  | "getChainId"
  | "getBlock"
  | "getTransaction"
  | "waitForTransactionReceipt"
  | "readContract"
>;

/** Bind replacements to the original actor and nonce before changing its recovery hash. */
export function readCharityEvidenceOutcome(
  client: Reader,
  record: CharityEvidenceRecord,
  submittedHash: Hex,
  assertCurrent: () => void,
  onRepriced: (hash: Hex) => void = () => {},
) {
  return charityEvidenceRead(assertCurrent, async (current) => {
    if (!hash(submittedHash))
      throw Error("The original evidence transaction hash is invalid.");
    const call = charityEvidenceCall(record);
    await verifyDirectCharityEvidenceTransaction(
      client,
      record,
      submittedHash,
      current,
    );
    current();
    const original = await client.getTransaction({ hash: submittedHash });
    current();
    if (
      !hash(original.hash) ||
      !equal(original.hash, submittedHash) ||
      !equal(original.from, record.account) ||
      !Number.isSafeInteger(original.nonce) ||
      original.nonce < 0
    )
      throw Error("The original evidence transaction identity is unavailable.");
    let reason: "repriced" | "replaced" | "cancelled" | undefined,
      expected = submittedHash;
    let receipt: Awaited<ReturnType<Reader["waitForTransactionReceipt"]>>;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash: submittedHash,
        onReplaced(value) {
          current();
          const next = value.transactionReceipt.transactionHash;
          if (!hash(next)) throw Error("Invalid replacement hash.");
          expected = next;
          reason = value.reason;
        },
      });
    } catch {
      throw new MarketReceiptPendingError();
    }
    current();
    if (reason && equal(expected, submittedHash))
      throw Error("A replacement must have a distinct transaction hash.");
    if (
      !hash(receipt.transactionHash) ||
      !equal(receipt.transactionHash, expected) ||
      !hash(receipt.blockHash) ||
      typeof receipt.blockNumber !== "bigint" ||
      receipt.blockNumber < 0n
    )
      throw Error(
        "The evidence receipt does not match the original request and mined block.",
      );
    const canonical = async () => {
      const [chain, block] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockNumber: receipt.blockNumber }),
      ]);
      current();
      if (
        chain !== record.chainId ||
        block.number !== receipt.blockNumber ||
        !block.hash ||
        !equal(block.hash, receipt.blockHash)
      )
        throw Error(
          "The evidence receipt block or chain changed. Its original request remains unresolved.",
        );
    };
    await canonical();
    const replacement = await client.getTransaction({ hash: expected });
    current();
    if (
      !hash(replacement.hash) ||
      !equal(replacement.hash, expected) ||
      !equal(replacement.from, original.from) ||
      replacement.nonce !== original.nonce
    )
      throw Error(
        "The replacement does not consume the original evidence request's actor and nonce.",
      );
    if (reason === "repriced") {
      if (
        !replacement.to ||
        !equal(replacement.to, record.target) ||
        replacement.value !== 0n ||
        !equal(replacement.input, encodeFunctionData(call))
      )
        throw Error(
          "The repriced transaction changed the reviewed evidence call.",
        );
    }
    if (
      reason === "replaced" ||
      reason === "cancelled" ||
      receipt.status === "reverted"
    ) {
      await canonical();
      current();
      throw new CharityEvidenceFinalError({
        originalHash: submittedHash,
        transactionHash: expected,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: reason && reason !== "repriced" ? "replaced" : "reverted",
      });
    }
    await verifyDirectCharityEvidenceTransaction(
      client,
      record,
      expected,
      current,
    );
    const result = await verifyCharityEvidenceReceipt(
      client,
      record,
      receipt,
      current,
    );
    current();
    await canonical();
    current();
    if (reason === "repriced") onRepriced(expected);
    return {
      ...result,
      outcome: {
        originalHash: submittedHash,
        transactionHash: expected,
        blockNumber: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash,
        status: "confirmed" as const,
      },
    };
  });
}
