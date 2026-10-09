import {
  decodeFunctionData,
  isAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  toBytes,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  artFiAdminSafeAbi,
  charityEditionsAbi,
  rwaRegistryAbi,
  vaultFactoryAbi,
} from "./contracts";
import {
  ZERO_ADDRESS,
  ZERO_REQUEST_ID,
  safeProposalRequestId,
  type SafeSubmission,
} from "./admin-safe";
import { publicSetting } from "./public-runtime-config";

export type SafeFlow = "rwa" | "vault" | "charity";
export const safeFlowSpec = {
  rwa: {
    name: "RWA creation",
    role: keccak256(toBytes("REGISTRAR_ROLE")),
    abi: rwaRegistryAbi,
    functionName: "createAssetWithEvidence",
  },
  vault: {
    name: "Vault creation",
    role: keccak256(toBytes("CREATOR_ROLE")),
    abi: vaultFactoryAbi,
    functionName: "createVault",
  },
  charity: {
    name: "Charity edition creation",
    role: keccak256(toBytes("SERIES_CREATOR_ROLE")),
    abi: charityEditionsAbi,
    functionName: "createSeries",
  },
} as const;
const roleAbi = parseAbi([
  "function hasRole(bytes32,address) view returns (bool)",
]);
export const sameSafeValue = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase();

export function configuredAdminSafe(): Address | undefined {
  const value = publicSetting("NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS")?.trim();
  if (!value) return undefined;
  if (!isAddress(value) || sameSafeValue(value, ZERO_ADDRESS))
    throw new Error("The deployment's administration safe address is invalid.");
  return value;
}

/** Select the existing role holder; a configured safe is never a role grant. */
export async function operatorCallRoute(
  client: Pick<PublicClient, "readContract">,
  kind: SafeFlow,
  target: Address,
  account: Address,
  safe?: Address,
): Promise<Address> {
  const role = safeFlowSpec[kind].role;
  if (
    safe &&
    (await client.readContract({
      address: target,
      abi: roleAbi,
      functionName: "hasRole",
      args: [role, safe],
    }))
  ) {
    if (
      !(await client.readContract({
        address: safe,
        abi: artFiAdminSafeAbi,
        functionName: "isOwner",
        args: [account],
      }))
    )
      throw new Error(
        "This target's role belongs to the configured safe. Connect one of its owners.",
      );
    return safe;
  }
  if (
    !(await client.readContract({
      address: target,
      abi: roleAbi,
      functionName: "hasRole",
      args: [role, account],
    }))
  )
    throw new Error(
      "Neither this wallet nor its configured safe holds the required target role.",
    );
  return account;
}

/** Only the existing creation selector on the deployment-bound target is exposed here. */
export function reviewSafeSubmission(
  kind: SafeFlow,
  target: Address,
  submission: SafeSubmission,
) {
  if (
    !sameSafeValue(target, submission.target) ||
    submission.value !== 0n ||
    sameSafeValue(submission.requestId, ZERO_REQUEST_ID)
  )
    throw new Error(
      "The proposal does not match the reviewed target, request identity and zero-value policy.",
    );
  const spec = safeFlowSpec[kind];
  const decoded = decodeFunctionData({ abi: spec.abi, data: submission.data });
  if (decoded.functionName !== spec.functionName)
    throw new Error(
      "This console only handles the existing creation call for this section.",
    );
  const operationId = decoded.args?.[0] as Hex;
  if (
    !operationId ||
    !sameSafeValue(
      safeProposalRequestId(operationId, target, submission.data),
      submission.requestId,
    )
  )
    throw new Error(
      "The safe proposal identity does not match this exact operation and calldata.",
    );
  const definition = spec.abi.find(
    (entry) => entry.type === "function" && entry.name === decoded.functionName,
  );
  const namedArgs = Object.fromEntries(
    (definition?.inputs ?? []).map((input, index) => [
      input.name || String(index),
      decoded.args?.[index],
    ]),
  );
  return { functionName: decoded.functionName, args: decoded.args, namedArgs };
}

export type SafeRecord = {
  chainId: number;
  wallet: Address;
  safe: Address;
  kind: SafeFlow;
  submission: Omit<SafeSubmission, "value">;
  transactionId?: string;
  startBlock: string;
  executionHash?: Hex;
  previousIds?: string[];
};
export function isSafeRecord(value: unknown): value is SafeRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as SafeRecord;
  const uint = (x: unknown) =>
    typeof x === "string" &&
    /^(0|[1-9][0-9]{0,77})$/.test(x) &&
    BigInt(x) < 2n ** 256n;
  const hex = (x: unknown, pattern: RegExp) =>
    typeof x === "string" && pattern.test(x);
  return (
    Number.isSafeInteger(v.chainId) &&
    v.chainId > 0 &&
    isAddress(v.wallet ?? "") &&
    isAddress(v.safe ?? "") &&
    v.kind in safeFlowSpec &&
    Boolean(v.submission) &&
    isAddress(v.submission.target ?? "") &&
    hex(v.submission.requestId, /^0x[\da-fA-F]{64}$/) &&
    hex(v.submission.data, /^0x(?:[\da-fA-F]{2}){4,12000}$/) &&
    uint(v.startBlock) &&
    (v.transactionId === undefined ||
      (uint(v.transactionId) && BigInt(v.transactionId) > 0n)) &&
    (v.previousIds === undefined ||
      (Array.isArray(v.previousIds) &&
        v.previousIds.length <= 32 &&
        v.previousIds.every((id) => uint(id) && BigInt(id) > 0n))) &&
    (v.executionHash === undefined ||
      hex(v.executionHash, /^0x[\da-fA-F]{64}$/))
  );
}
export const recordSubmission = (record: SafeRecord): SafeSubmission => ({
  ...record.submission,
  value: 0n,
});

export async function loadSafeProposal(
  client: Pick<PublicClient, "getBlock" | "readContract">,
  safe: Address,
  account: Address,
  id?: bigint,
) {
  const block = await client.getBlock();
  const read = {
    address: safe,
    abi: artFiAdminSafeAbi,
    blockNumber: block.number,
  } as const;
  const [threshold, delay, owner, owners, transaction, confirmed] =
    await Promise.all([
      client.readContract({ ...read, functionName: "threshold" }),
      client.readContract({ ...read, functionName: "delaySeconds" }),
      client.readContract({
        ...read,
        functionName: "isOwner",
        args: [account],
      }),
      client.readContract({ ...read, functionName: "owners" }),
      id === undefined
        ? undefined
        : client.readContract({
            ...read,
            functionName: "transaction",
            args: [id],
          }),
      id === undefined
        ? false
        : client.readContract({
            ...read,
            functionName: "confirmedBy",
            args: [id, account],
          }),
    ]);
  if (
    threshold < 2n ||
    BigInt(delay) === 0n ||
    BigInt(owners.length) < threshold
  )
    throw new Error(
      "The configured contract does not match the administration safe's threshold and delay policy.",
    );
  return {
    threshold,
    delay: BigInt(delay),
    owner,
    owners,
    transaction,
    confirmed,
    now: block.timestamp,
    blockNumber: block.number,
  };
}
export type SafeLiveState = Awaited<ReturnType<typeof loadSafeProposal>>;

export function submittedProposal(
  receipt: Pick<TransactionReceipt, "logs">,
  safe: Address,
  account: Address,
  submission: SafeSubmission,
) {
  return parseEventLogs({
    abi: artFiAdminSafeAbi,
    eventName: "TransactionSubmitted",
    strict: true,
    logs: receipt.logs.filter((log) => sameSafeValue(log.address, safe)),
  }).find(
    ({ args }) =>
      sameSafeValue(args.requestId, submission.requestId) &&
      sameSafeValue(args.proposer, account) &&
      sameSafeValue(args.target, submission.target) &&
      args.value === 0n &&
      sameSafeValue(args.dataHash, keccak256(submission.data)),
  )?.args.transactionId;
}

export function assertSameSafeSubmission(
  expected: SafeSubmission,
  actual: SafeSubmission,
) {
  if (
    !sameSafeValue(expected.target, actual.target) ||
    !sameSafeValue(expected.requestId, actual.requestId) ||
    expected.value !== actual.value ||
    !sameSafeValue(expected.data, actual.data)
  )
    throw new Error(
      "The on-chain proposal differs from the exact reviewed call.",
    );
}

/** A recovery hash must be the same owner, safe, method and arguments as the pending action. */
export async function verifySafeTransaction(
  client: Pick<PublicClient, "getTransaction">,
  hash: Hex,
  record: SafeRecord,
  action: string,
) {
  const transaction = await client.getTransaction({ hash });
  if (
    !transaction.to ||
    !sameSafeValue(transaction.to, record.safe) ||
    !sameSafeValue(transaction.from, record.wallet) ||
    transaction.value !== 0n
  )
    throw new Error("The transaction does not match this safe and owner.");
  const decoded = decodeFunctionData({
    abi: artFiAdminSafeAbi,
    data: transaction.input,
  });
  if (decoded.functionName !== action)
    throw new Error("The transaction does not match the pending safe action.");
  if (action === "submit") {
    if (decoded.functionName !== "submit")
      throw new Error("Invalid proposal submission.");
    const [requestId, target, value, data] = decoded.args;
    assertSameSafeSubmission(recordSubmission(record), {
      requestId,
      target,
      value,
      data,
    });
  } else if (
    !record.transactionId ||
    String(decoded.args?.[0]) !== record.transactionId
  )
    throw new Error("The transaction does not match the reviewed proposal ID.");
}

/** Recover an execution performed by another owner without pretending the current owner sent it. */
export async function recoverSafeExecution(
  client: Pick<PublicClient, "getTransaction" | "getTransactionReceipt">,
  hash: Hex,
  record: SafeRecord,
) {
  if (!record.transactionId)
    throw new Error("Load the proposal before recovering its execution.");
  const transaction = await client.getTransaction({ hash });
  await verifySafeTransaction(
    client,
    hash,
    { ...record, wallet: transaction.from },
    "execute",
  );
  const receipt = await client.getTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw new Error("The execution transaction is not successful.");
  const event = parseEventLogs({
    abi: artFiAdminSafeAbi,
    eventName: "TransactionExecuted",
    strict: true,
    logs: receipt.logs.filter((log) => sameSafeValue(log.address, record.safe)),
  }).find(
    ({ args }) =>
      args.transactionId.toString() === record.transactionId &&
      sameSafeValue(args.executor, transaction.from),
  );
  if (!event)
    throw new Error(
      "The execution receipt does not contain this safe's exact proposal event.",
    );
  return receipt.transactionHash;
}

/** Blank new-Vault privileged roles follow the reviewed execution authority; ownership remains separate. */
export function vaultRoleDefaults(
  wallet: Address,
  executionAuthority: Address = wallet,
) {
  return {
    adminAddress: executionAuthority,
    pauserAddress: executionAuthority,
    fractionalizerAddress: wallet,
    recipient: wallet,
  };
}

/** A successful idempotent submit simulation may refer to an existing proposal, requiring no new write. */
export async function existingSafeSubmission(
  client: Pick<PublicClient, "readContract">,
  safe: Address,
  submission: SafeSubmission,
  simulatedId: bigint,
) {
  const count = await client.readContract({
    address: safe,
    abi: artFiAdminSafeAbi,
    functionName: "transactionCount",
  });
  if (simulatedId > count) return false;
  const transaction = await client.readContract({
    address: safe,
    abi: artFiAdminSafeAbi,
    functionName: "transaction",
    args: [simulatedId],
  });
  assertSameSafeSubmission(submission, transaction);
  return true;
}
