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
export type CharityEvidenceRecord = {
  chainId: 560048;
  account: Address;
  target: Address;
  tokenId: string;
  action: CharityEvidenceAction;
  evidenceHash: Hex;
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
    Object.keys(v).length === 6 &&
    Object.keys(v).every((key) =>
      [
        "chainId",
        "account",
        "target",
        "tokenId",
        "action",
        "evidenceHash",
      ].includes(key),
    ) &&
    v.chainId === 560048 &&
    address(v.account) &&
    address(v.target) &&
    uint(v.tokenId) &&
    ["sellout", "donation"].includes(v.action) &&
    commitment(v.evidenceHash)
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
) {
  const call = charityEvidenceCall(record);
  if ((await client.getChainId()) !== record.chainId)
    throw new Error("The RPC chain does not match Hoodi.");
  const block = await client.getBlock();
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
  if (!validState(state)) throw failure();
  const balance =
    record.action === "sellout"
      ? await client.readContract({
          ...read,
          functionName: "balanceOf",
          args: [state.distributionWallet, BigInt(record.tokenId)],
        })
      : undefined;
  checkCharityEvidencePreconditions(record, state, paused, balance);
  const caller = await operatorCallRoute(
    client,
    charityEvidenceFlow(record.action),
    record.target,
    record.account,
    safe,
  );
  await client.simulateContract({ ...call, account: caller });
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
) {
  const call = charityEvidenceCall(record);
  if ((await client.getChainId()) !== record.chainId) throw failure();
  const transaction = await client.getTransaction({ hash });
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
) {
  charityEvidenceCall(record);
  if (
    (await client.getChainId()) !== record.chainId ||
    receipt.status !== "success"
  )
    throw failure();
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
  const state = await client.readContract({
    address: record.target,
    abi: charityEditionsAbi,
    functionName: "series",
    args: [BigInt(record.tokenId)],
    blockNumber: receipt.blockNumber,
  });
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
  if (
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
