import {
  encodeFunctionData,
  isAddress,
  parseEventLogs,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { charityEditionsAbi } from "./contracts";
import { encodeOperatorSafeSubmission } from "./admin-safe";
import {
  operatorCallRoute,
  reviewSafeSubmission,
  type SafeFlow,
} from "./admin-safe-client";

export type CharityEvidenceAction = "sellout" | "donation";
export type CharityEvidenceOutcome = {
  originalHash: Hex;
  transactionHash: Hex;
  blockNumber: string;
  blockHash: Hex;
  status: "confirmed" | "reverted" | "replaced";
};
export type CharityEvidenceRecord = {
  chainId: 560048;
  account: Address;
  target: Address;
  tokenId: string;
  action: CharityEvidenceAction;
  evidenceHash: Hex;
  outcome?: CharityEvidenceOutcome;
};
export type CharityEvidenceState = {
  createdAt: bigint;
  soldOutAt: bigint;
  physicalDonationRecordedAt: bigint;
  selloutEvidenceHash: Hex;
  physicalDonationEvidenceHash: Hex;
  distributionWallet: Address;
};
const uint = (value: unknown) =>
  typeof value === "string" &&
  /^[1-9][0-9]{0,77}$/.test(value) &&
  BigInt(value) < 2n ** 256n;
const commitment = (value: unknown): value is Hex =>
  typeof value === "string" &&
  /^0x[0-9a-fA-F]{64}$/.test(value) &&
  value.toLowerCase() !== zeroHash;
const address = (value: unknown): value is Address =>
  typeof value === "string" &&
  isAddress(value) &&
  value.toLowerCase() !== zeroAddress;
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const failure = () =>
  new Error(
    "The charity evidence operation does not match its reviewed bindings.",
  );

export function isCharityEvidenceRecord(
  value: unknown,
): value is CharityEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as CharityEvidenceRecord;
  return (
    Object.keys(v).filter((key) => key !== "outcome").length === 6 &&
    Object.keys(v).every((key) =>
      [
        "chainId",
        "account",
        "target",
        "tokenId",
        "action",
        "evidenceHash",
        "outcome",
      ].includes(key),
    ) &&
    v.chainId === 560048 &&
    address(v.account) &&
    address(v.target) &&
    uint(v.tokenId) &&
    ["sellout", "donation"].includes(v.action) &&
    commitment(v.evidenceHash) &&
    (v.outcome === undefined ||
      (v.outcome &&
        typeof v.outcome === "object" &&
        Object.keys(v.outcome).length === 5 &&
        Object.keys(v.outcome).every((key) =>
          [
            "originalHash",
            "transactionHash",
            "blockNumber",
            "blockHash",
            "status",
          ].includes(key),
        ) &&
        typeof v.outcome.blockNumber === "string" &&
        commitment(v.outcome.originalHash) &&
        commitment(v.outcome.transactionHash) &&
        commitment(v.outcome.blockHash) &&
        /^(0|[1-9][0-9]{0,77})$/.test(v.outcome.blockNumber) &&
        BigInt(v.outcome.blockNumber) < 2n ** 256n &&
        ["confirmed", "reverted", "replaced"].includes(v.outcome.status)))
  );
}

export function charityEvidenceFlow(action: CharityEvidenceAction): SafeFlow {
  if (action === "sellout") return "charity-sellout";
  if (action === "donation") return "charity-donation";
  throw failure();
}

export function charityEvidenceCall(record: CharityEvidenceRecord) {
  if (!isCharityEvidenceRecord(record)) throw failure();
  return {
    address: record.target,
    abi: charityEditionsAbi,
    chainId: record.chainId,
    functionName:
      record.action === "sellout"
        ? ("recordSellout" as const)
        : ("recordPhysicalDonation" as const),
    args: [BigInt(record.tokenId), record.evidenceHash] as const,
  };
}

export function charityEvidenceSafeSubmission(record: CharityEvidenceRecord) {
  const call = charityEvidenceCall(record);
  // Reuse the existing exact-calldata safe request binding. No new digest scheme.
  const submission = encodeOperatorSafeSubmission({
    ...call,
    target: record.target,
    requestId: record.evidenceHash,
  });
  reviewSafeSubmission(
    charityEvidenceFlow(record.action),
    record.target,
    submission,
    BigInt(record.tokenId),
  );
  return submission;
}

function validState(value: CharityEvidenceState) {
  return (
    value &&
    address(value.distributionWallet) &&
    [value.createdAt, value.soldOutAt, value.physicalDonationRecordedAt].every(
      (v) => typeof v === "bigint" && v >= 0n && v < 2n ** 64n,
    ) &&
    [value.selloutEvidenceHash, value.physicalDonationEvidenceHash].every(
      (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v),
    )
  );
}

export function checkCharityEvidencePreconditions(
  record: CharityEvidenceRecord,
  state: CharityEvidenceState,
  paused: boolean,
  distributorBalance?: bigint,
) {
  if (
    !isCharityEvidenceRecord(record) ||
    !validState(state) ||
    state.createdAt === 0n ||
    typeof paused !== "boolean"
  )
    throw failure();
  if (paused) throw new Error("The charity editions contract is paused.");
  if (record.action === "sellout") {
    if (state.soldOutAt !== 0n)
      throw new Error(
        "Sellout is already recorded. Inspect the original evidence; do not record it again.",
      );
    if (typeof distributorBalance !== "bigint" || distributorBalance !== 0n)
      throw new Error(
        "The original distribution wallet must have zero units before sellout can be recorded.",
      );
  } else {
    if (state.soldOutAt === 0n)
      throw new Error(
        "Sellout must be recorded before physical donation acceptance.",
      );
    if (state.physicalDonationRecordedAt !== 0n)
      throw new Error(
        "Physical donation is already recorded. Inspect the original evidence; do not record it again.",
      );
  }
}

export async function prepareCharityEvidence(
  client: Pick<
    PublicClient,
    "getChainId" | "getBlock" | "readContract" | "simulateContract"
  >,
  record: CharityEvidenceRecord,
  safe?: Address,
  assertCurrent: () => void = () => {},
) {
  const call = charityEvidenceCall(record);
  if ((await client.getChainId()) !== record.chainId)
    throw new Error("The RPC chain does not match Hoodi.");
  assertCurrent();
  const block = await client.getBlock();
  assertCurrent();
  if (
    typeof block.number !== "bigint" ||
    block.number < 0n ||
    !block.hash ||
    !commitment(block.hash)
  )
    throw failure();
  const read = {
    address: record.target,
    abi: charityEditionsAbi,
    blockNumber: block.number,
  } as const;
  const [state, paused] = await Promise.all([
    client.readContract({
      ...read,
      functionName: "series",
      args: [BigInt(record.tokenId)],
    }),
    client.readContract({ ...read, functionName: "paused" }),
  ]);
  assertCurrent();
  if (!validState(state)) throw failure();
  const balance =
    record.action === "sellout"
      ? await client.readContract({
          ...read,
          functionName: "balanceOf",
          args: [state.distributionWallet, BigInt(record.tokenId)],
        })
      : undefined;
  assertCurrent();
  checkCharityEvidencePreconditions(record, state, paused, balance);
  const caller = await operatorCallRoute(
    client,
    charityEvidenceFlow(record.action),
    record.target,
    record.account,
    safe,
  );
  assertCurrent();
  await client.simulateContract({ ...call, account: caller });
  assertCurrent();
  const [chain, canonical] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockNumber: block.number }),
  ]);
  assertCurrent();
  if (
    chain !== record.chainId ||
    canonical.number !== block.number ||
    !canonical.hash ||
    !equal(canonical.hash, block.hash)
  )
    throw Error(
      "The charity evidence preparation block or chain changed. Review again before any wallet request.",
    );
  return {
    caller,
    state,
    observedBlock: block.number,
    safeSubmission:
      safe && equal(caller, safe)
        ? charityEvidenceSafeSubmission(record)
        : undefined,
  };
}

/** Before accepting a supplied/repriced direct hash, bind its actual sender, target and full input. */
export async function verifyDirectCharityEvidenceTransaction(
  client: Pick<PublicClient, "getChainId" | "getTransaction">,
  record: CharityEvidenceRecord,
  hash: Hex,
  assertCurrent: () => void = () => {},
) {
  const call = charityEvidenceCall(record);
  if ((await client.getChainId()) !== record.chainId) throw failure();
  assertCurrent();
  if (!commitment(hash)) throw failure();
  const transaction = await client.getTransaction({ hash });
  assertCurrent();
  if (
    !transaction.to ||
    !equal(transaction.to, record.target) ||
    !equal(transaction.from, record.account) ||
    transaction.value !== 0n ||
    !equal(transaction.input, encodeFunctionData(call))
  )
    throw failure();
}

/** A successful transaction requires the exact event and matching canonical recorded state. */
export async function verifyCharityEvidenceReceipt(
  client: Pick<PublicClient, "getChainId" | "getBlock" | "readContract">,
  record: CharityEvidenceRecord,
  receipt: TransactionReceipt,
  assertCurrent: () => void = () => {},
) {
  charityEvidenceCall(record);
  assertCurrent();
  if (
    !commitment(receipt.transactionHash) ||
    !commitment(receipt.blockHash) ||
    typeof receipt.blockNumber !== "bigint" ||
    receipt.blockNumber < 0n
  )
    throw failure();
  if (
    (await client.getChainId()) !== record.chainId ||
    receipt.status !== "success"
  )
    throw failure();
  assertCurrent();
  if (
    receipt.logs.some((log) => equal(log.address, record.target) && log.removed)
  )
    throw failure();
  const eventName =
    record.action === "sellout"
      ? ("SelloutRecorded" as const)
      : ("PhysicalDonationRecorded" as const);
  const events = parseEventLogs({
    abi: charityEditionsAbi,
    eventName,
    strict: true,
    logs: receipt.logs.filter((log) => equal(log.address, record.target)),
  });
  if (
    events.length !== 1 ||
    events[0].args.tokenId !== BigInt(record.tokenId) ||
    !equal(events[0].args.evidenceHash, record.evidenceHash)
  )
    throw failure();
  const before = await client.getBlock({ blockNumber: receipt.blockNumber });
  assertCurrent();
  if (
    before.number !== receipt.blockNumber ||
    !before.hash ||
    !equal(before.hash, receipt.blockHash)
  )
    throw Error(
      "The evidence receipt is not reconciled with the canonical chain state.",
    );
  const state = await client.readContract({
    address: record.target,
    abi: charityEditionsAbi,
    functionName: "series",
    args: [BigInt(record.tokenId)],
    blockNumber: receipt.blockNumber,
  });
  assertCurrent();
  if (!validState(state)) throw failure();
  const timestamp =
    record.action === "sellout"
      ? state.soldOutAt
      : state.physicalDonationRecordedAt;
  const hash =
    record.action === "sellout"
      ? state.selloutEvidenceHash
      : state.physicalDonationEvidenceHash;
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  const chain = await client.getChainId();
  assertCurrent();
  if (
    chain !== record.chainId ||
    canonical.number !== receipt.blockNumber ||
    state.createdAt === 0n ||
    (record.action === "donation" && state.soldOutAt === 0n) ||
    timestamp === 0n ||
    timestamp !== canonical.timestamp ||
    !equal(hash, record.evidenceHash) ||
    !canonical.hash ||
    !equal(canonical.hash, receipt.blockHash)
  )
    throw new Error(
      "The evidence receipt is not reconciled with the canonical chain state. Check the original transaction; do not resubmit.",
    );
  return {
    action: record.action,
    tokenId: record.tokenId,
    evidenceHash: record.evidenceHash,
    recordedAt: timestamp,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
  };
}
