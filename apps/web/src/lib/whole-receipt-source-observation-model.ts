import { z } from "zod";
import { keccak256, toBytes } from "viem";

// Exact optional Oracle extension schema; this is not an ERC-8415 requirement.
export const wholeReceiptSourceSchemaId = keccak256(
  toBytes("oracle.receipt-binding.v1"),
);
const zero = /^0x0+$/i;
const uint = (bits: number, minimum = 0n) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .refine((value) => {
      try {
        return BigInt(value) >= minimum && BigInt(value) < 1n << BigInt(bits);
      } catch {
        return false;
      }
    });
const hash = (allowZero = false) =>
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .refine((x) => allowZero || !zero.test(x));
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((x) => !zero.test(x));
const source = z
  .object({
    chainId: uint(256, 1n),
    contract: address,
    registerId: hash(),
    sourceAuthority: address,
  })
  .strict();
const entry = z
  .object({
    recordCommitment: hash(),
    previousCommitment: hash(true),
    registryReference: hash(true),
    holder: address,
    version: uint(64, 1n),
    effectiveAt: uint(64),
    supersededAt: uint(64),
  })
  .strict()
  .refine(
    (x) =>
      x.supersededAt === "0" || BigInt(x.supersededAt) > BigInt(x.effectiveAt),
  );
const binding = z
  .object({
    schemaId: hash(true),
    mintPolicyHash: hash(true),
    segmentDigest: hash(true),
    requestHash: hash(true),
    receiptDocumentHash: hash(true),
  })
  .strict();
// Oracle reader metadata is retained as transport evidence, never authority.
const sourceBlockSchema = z
  .object({ number: uint(256), hash: hash() })
  .strict();
const sourceReadEvidenceSchema = z
  .object({
    kind: z.literal("canonical-contract-state"),
    head: sourceBlockSchema,
    minimumConfirmations: z.number().int().min(1).max(256),
  })
  .strict();
const snapshotSchema = z
  .object({
    tokenId: uint(256),
    source,
    block: sourceBlockSchema,
    entry,
    mintPolicyHash: hash(),
    receiptBinding: binding,
    receiptAvailable: z.boolean(),
    evidence: sourceReadEvidenceSchema.optional(),
  })
  .strict()
  .refine((value) => {
    const evidence = value.evidence;
    if (!evidence) return true; // Internal canonical-RPC snapshots have no HTTP envelope.
    try {
      const anchor = BigInt(value.block.number),
        head = BigInt(evidence.head.number);
      return (
        head >= anchor &&
        head - anchor + 1n >= BigInt(evidence.minimumConfirmations) &&
        (head !== anchor ||
          evidence.head.hash.toLowerCase() === value.block.hash.toLowerCase())
      );
    } catch {
      return false;
    }
  });
const expectedSchema = z
  .object({
    tokenId: uint(256),
    source,
    mintPolicyHash: hash(),
    entry: z
      .object({
        recordCommitment: hash(),
        previousCommitment: hash(true),
        registryReference: hash(true),
        holder: address,
        version: uint(64, 2n),
        effectiveAt: uint(64),
      })
      .strict(),
    receiptBinding: z
      .object({
        schemaId: hash(),
        mintPolicyHash: hash(),
        segmentDigest: hash(),
        requestHash: hash(),
        receiptDocumentHash: hash(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (x) =>
      x.receiptBinding.schemaId.toLowerCase() === wholeReceiptSourceSchemaId &&
      x.receiptBinding.mintPolicyHash.toLowerCase() ===
        x.mintPolicyHash.toLowerCase(),
  );
export type ExpectedWholeReceiptSource = z.infer<typeof expectedSchema>;
export type WholeReceiptSourceSnapshot = z.infer<typeof snapshotSchema>;
export type WholeReceiptSourceCode =
  | "RECEIPT_EXPECTATION_INVALID"
  | "RECEIPT_ORACLE_NOT_CONFIGURED"
  | "RECEIPT_ORACLE_CONFIG_INVALID"
  | "RECEIPT_SOURCE_UNAVAILABLE"
  | "RECEIPT_SOURCE_MALFORMED"
  | "RECEIPT_BINDING_MISMATCH"
  | "RECEIPT_NOT_AVAILABLE"
  | "RECEIPT_TIMEOUT"
  | "RECEIPT_CANCELLED";
export class WholeReceiptSourceError extends Error {
  constructor(readonly code: WholeReceiptSourceCode) {
    super(code);
  }
}
export const refuseReceipt = (code: WholeReceiptSourceCode): never => {
  throw new WholeReceiptSourceError(code);
};

/** Bounded own-data JSON snapshot. Never invoke input getters or retain a caller-owned plan. */
function plainSnapshot(value: unknown): unknown {
  let budget = 2048;
  const copy = (v: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 8) throw Error("bounded JSON required");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > 65536) throw Error("oversized string");
      return v;
    }
    if (typeof v === "number" && Number.isSafeInteger(v)) return v;
    if (
      !v ||
      typeof v !== "object" ||
      Object.getPrototypeOf(v) !== Object.prototype
    )
      throw Error("plain object required");
    const descriptors = Object.getOwnPropertyDescriptors(v);
    return Object.fromEntries(
      Reflect.ownKeys(descriptors).map((key) => {
        if (typeof key !== "string") throw Error("string key required");
        const d = descriptors[key];
        if (!d.enumerable || !Object.hasOwn(d, "value"))
          throw Error("data property required");
        return [key, copy(d.value, depth + 1)];
      }),
    );
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65536)
    throw Error("oversized JSON");
  return result;
}
function frozen<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
export function snapshotWholeReceiptExpectation(input: unknown) {
  try {
    return frozen(expectedSchema.parse(plainSnapshot(input)));
  } catch {
    return refuseReceipt("RECEIPT_EXPECTATION_INVALID");
  }
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Compare source observations only. No capability, registration, finality or payment authority. */
export function observeWholeReceiptSource(
  expectedInput: unknown,
  observedInput: unknown,
) {
  const expected = snapshotWholeReceiptExpectation(expectedInput);
  let observed: WholeReceiptSourceSnapshot;
  try {
    observed = snapshotSchema.parse(plainSnapshot(observedInput));
  } catch {
    return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
  }
  if (
    observed.tokenId !== expected.tokenId ||
    observed.source.chainId !== expected.source.chainId ||
    !same(observed.source.contract, expected.source.contract) ||
    !same(observed.source.registerId, expected.source.registerId) ||
    !same(observed.source.sourceAuthority, expected.source.sourceAuthority) ||
    observed.entry.version !== expected.entry.version
  )
    return refuseReceipt("RECEIPT_BINDING_MISMATCH");
  const values = Object.values(observed.receiptBinding);
  const absent = values.every((value) => zero.test(value));
  if (absent) {
    if (observed.receiptAvailable)
      return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
    return refuseReceipt("RECEIPT_NOT_AVAILABLE");
  }
  if (
    !observed.receiptAvailable ||
    values.some((value) => zero.test(value)) ||
    !same(observed.receiptBinding.schemaId, wholeReceiptSourceSchemaId) ||
    !same(observed.receiptBinding.mintPolicyHash, observed.mintPolicyHash)
  )
    return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
  if (!same(observed.mintPolicyHash, expected.mintPolicyHash))
    return refuseReceipt("RECEIPT_BINDING_MISMATCH");
  for (const field of [
    "schemaId",
    "mintPolicyHash",
    "segmentDigest",
    "requestHash",
    "receiptDocumentHash",
  ] as const) {
    if (!same(observed.receiptBinding[field], expected.receiptBinding[field]))
      return refuseReceipt("RECEIPT_BINDING_MISMATCH");
  }
  for (const field of [
    "recordCommitment",
    "previousCommitment",
    "registryReference",
    "holder",
  ] as const) {
    if (!same(observed.entry[field], expected.entry[field]))
      return refuseReceipt("RECEIPT_BINDING_MISMATCH");
  }
  if (observed.entry.effectiveAt !== expected.entry.effectiveAt)
    return refuseReceipt("RECEIPT_BINDING_MISMATCH");
  return frozen({
    kind: "oracle-receipt-source-observation" as const,
    authorization: "NOT_ESTABLISHED" as const,
    finality: "NOT_ESTABLISHED" as const,
    originalDocumentVerification: "NOT_ESTABLISHED" as const,
    snapshot: observed,
  });
}
/** The HTTP read contract requires its complete reader evidence. Internal
 * canonical-RPC reconstruction still uses observeWholeReceiptSource directly.
 * Structural confirmation metadata is not independently verified finality. */
export function observeWholeReceiptReadResponse(
  expectedInput: unknown,
  observedInput: unknown,
) {
  const observation = observeWholeReceiptSource(expectedInput, observedInput);
  if (!observation.snapshot.evidence)
    return refuseReceipt("RECEIPT_SOURCE_MALFORMED");
  return observation;
}

export type WholeReceiptSourceObservation = ReturnType<
  typeof observeWholeReceiptSource
>;
