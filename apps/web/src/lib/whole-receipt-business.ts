import "server-only";
import { z } from "zod";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashStruct,
  hashTypedData,
  isAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import { saleIntentTypes } from "./whole-artwork-intent";

const phases = ["funded", "registered", "paid"] as const;
const uint = (bits = 256, positive = false) => z.string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine(x => BigInt(x) < 1n << BigInt(bits) && (!positive || x !== "0"));
const address = z.string().refine(x => isAddress(x) && !/^0x0{40}$/i.test(x));
const hash = (zero = false) => z.string().regex(/^0x[0-9a-fA-F]{64}$/)
  .refine(x => zero || !/^0x0{64}$/i.test(x));
const chain = z.union([z.literal(31337), z.literal(560048)]);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const sale = z.object({
  seller: address, collection: address, tokenId: uint(), paymentToken: address,
  price: uint(256, true), buyer: address, salt: uint(),
  startsAt: z.number().int().min(0).max(2 ** 48 - 1),
  endsAt: z.number().int().positive().max(2 ** 48 - 1), epoch: uint(),
}).strict().refine(x => x.startsAt < x.endsAt && x.seller.toLowerCase() !== x.buyer.toLowerCase());
const correspondenceKeys = ["settlementId", "assetRecordHash", "oracleSourceId", "requestHash",
  "executionReferenceHash", "previousSegment", "oldCertificateHash", "warehouseReceiptHash"] as const;
const correspondence = z.object({
  settlementId: hash(), assetRecordHash: hash(), oracleSourceId: hash(), requestHash: hash(),
  executionReferenceHash: hash(), previousSegment: hash(true), oldCertificateHash: hash(), warehouseReceiptHash: hash(),
}).strict();
const principal = z.object({
  kind: z.literal("task"), taskId: id, taskDigest: hash().refine(x => /^0x[0-9a-f]{64}$/.test(x)), executorDigest: hash().refine(x => /^0x[0-9a-f]{64}$/.test(x)),
  grantReference: z.string().regex(/^grant:[A-Za-z0-9_-]{1,122}$/),
  grantPolicyVersion: uint(256, true), operationId: id,
}).strict();
const receipt = z.object({
  schemaVersion: z.literal(1), phase: z.enum(phases), segmentId: hash(),
  domain: z.object({ chainId: chain, verifyingContract: address }).strict(),
  sale, correspondence,
  kitRegistration: z.object({ version: uint(64, true).refine(x => BigInt(x) >= 2n), proofHash: hash() }).strict().optional(),
}).strict();
const plan = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  chainId: chain, taskPrincipal: principal, request: z.object({ account: address }).strict(),
  kind: z.literal("transaction"), wholeReceipt: receipt,
}).strict();
const slot = z.object({
  phase: z.enum(phases), nonce: uint().refine(x => BigInt(x) <= BigInt(Number.MAX_SAFE_INTEGER)),
  calldataHash: hash(), planDigest: hash(), journalBindingHash: hash(),
  gasLimit: uint(256, true), maxFeePerGasWei: uint(256, true), maxPriorityFeePerGasWei: uint(),
}).strict();
const policy = z.object({
  schema: z.literal("8415-agent-task/1"), taskId: id,
  tenant: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), origin: z.string(),
  chainId: uint(256, true), actor: address, expiresAt: uint(64, true),
  fees: z.object({ perOperationWei: uint(256, true), totalWei: uint(256, true) }).strict(),
  intent: z.object({
    kind: z.literal("artfi-receipt"), handlerId: z.literal("artfi:whole-receipt:v1"),
    escrow: address, runtimeCodeHash: hash(), segmentId: hash(),
    sale: z.object({
      seller: address, collection: address, tokenId: uint(), paymentToken: address,
      price: uint(256, true), buyer: address, salt: uint(), startsAt: uint(48),
      endsAt: uint(48, true), epoch: uint(),
    }).strict(), correspondence, phases: z.array(slot).min(1).max(3),
    recovery: z.object({ funding: z.literal("once"), payout: z.literal("once"), unknownOutcome: z.literal("reconcile-only") }).strict(),
  }).strict(),
}).strict();
const wire = z.object({
  account: address, chainId: uint(256, true), to: address,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){4,16384}$/), value: z.literal("0"),
  nonce: uint(), gasLimit: uint(256, true), maxFeePerGasWei: uint(256, true), maxPriorityFeePerGasWei: uint(),
}).strict();
const saleTuple = "(address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch)";
const correspondenceTuple = "(bytes32 settlementId,bytes32 assetRecordHash,bytes32 oracleSourceId,bytes32 requestHash,bytes32 executionReferenceHash,bytes32 previousSegment,bytes32 oldCertificateHash,bytes32 warehouseReceiptHash)";
const abi = parseAbi([
  `function fund(${saleTuple} sale,${correspondenceTuple} correspondence,bytes signature)`,
  "function confirmRegistration(bytes32 id,bytes evidence)", "function paySeller(bytes32 id)",
]);
const evidence = parseAbiParameters(`${saleTuple} sale,${correspondenceTuple} correspondence,uint64 version,bytes proof`);
const authorizationTypes = { ReceiptAuthorization: [
  { name: "saleIntentHash", type: "bytes32" },
  ...correspondenceKeys.map(name => ({ name, type: "bytes32" as const })),
] } as const;

function refuse(): never { throw Error("RECEIPT_BUSINESS_BINDING_REFUSED"); }
/** Copy data properties without invoking accessors. No prototype/symbol/array-hole
 * fallback. This boundary accepts the same bounded JSON data as the native plan. */
function snapshot(raw: unknown): unknown {
  let remaining = 12000;
  const copy = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 16) refuse();
    if (typeof value === "string" && value.length > 65536) refuse();
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (!value || typeof value !== "object") refuse();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) refuse();
      return Array.from({ length: value.length }, (_, n) => {
        const d = descriptors[String(n)];
        if (!d || !Object.hasOwn(d, "value")) refuse();
        return copy(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(value) !== Object.prototype || keys.some(k => typeof k !== "string")) refuse();
    return Object.fromEntries(keys.map(key => {
      const d = descriptors[key as string];
      if (!d || !d.enumerable || !Object.hasOwn(d, "value")) refuse();
      return [key, copy(d.value, depth + 1)];
    }));
  };
  const result = copy(raw, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 65536) refuse();
  return result;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function frozen<T>(x: T): Readonly<T> {
  if (x && typeof x === "object") { Object.values(x).forEach(frozen); Object.freeze(x); }
  return x;
}
function saleValues(s: z.infer<typeof sale>) {
  return { ...s, seller: s.seller as Address, collection: s.collection as Address,
    buyer: s.buyer as Address, paymentToken: s.paymentToken as Address,
    tokenId: BigInt(s.tokenId), price: BigInt(s.price), salt: BigInt(s.salt), epoch: BigInt(s.epoch) };
}
function correspondenceValues(c: z.infer<typeof correspondence>) {
  return Object.fromEntries(correspondenceKeys.map(k => [k, c[k]])) as Record<typeof correspondenceKeys[number], Hex>;
}
export type WholeReceiptBusinessProjection = Pick<z.infer<typeof plan>, "kind" | "chainId" | "request" | "wholeReceipt">;

/** Validates the existing native shape and separates pregrant business from
 * grant-derived transport IDs. No new hash/domain or authority is introduced.
 * Keep the full original plan for native wire hashing and principal verification. */
export function projectWholeReceiptBusiness(rawPlan: unknown) {
  try {
    const p = plan.parse(snapshot(rawPlan)), r = p.wholeReceipt;
    const { kind, ...binding } = p.taskPrincipal;
    if (kind !== "task" || p.operationId !== `native_${kernelRequestDigest(binding)}` ||
        p.chainId !== r.domain.chainId || (r.phase === "registered" ? !r.kitRegistration : r.kitRegistration !== undefined) ||
        (r.phase === "funded" && !same(p.request.account, r.sale.buyer))) refuse();
    const expected = hashTypedData({
      domain: { name: "ArtFi Whole Artwork Receipt Settlement", version: "1", chainId: r.domain.chainId,
        verifyingContract: r.domain.verifyingContract as Address },
      types: authorizationTypes, primaryType: "ReceiptAuthorization",
      message: { saleIntentHash: hashStruct({ data: saleValues(r.sale), types: saleIntentTypes, primaryType: "SaleIntent" }),
        ...correspondenceValues(r.correspondence) },
    });
    if (!same(expected, r.segmentId)) refuse();
    // Copy only explicitly named business fields. Never mutate the native plan.
    const business: WholeReceiptBusinessProjection = { kind: p.kind, chainId: p.chainId,
      request: structuredClone(p.request), wholeReceipt: structuredClone(r) };
    return frozen({ business, nativePlan: p });
  } catch { refuse(); }
}

/** Compare against policy and exact wire obtained inside the installation's
 * real held receipt context. Caller authentication is mandatory and external:
 * this function does not verify a grant, mint a capability or authorize a send.
 * Slot planDigest/journalBindingHash remain opaque; comparison here is NOT their
 * recomputation. The Go consumer must stay closed until that contract is wired. */
export function matchWholeReceiptBusiness(rawPlan: unknown, rawPolicy: unknown, rawWire: unknown) {
  try {
    const projected = projectWholeReceiptBusiness(rawPlan), p = projected.nativePlan, r = p.wholeReceipt;
    const t = policy.parse(snapshot(rawPolicy)), w = wire.parse(snapshot(rawWire)), i = t.intent;
    // freezeReceiptTask canonicalizes addresses and bytes32 values to lowercase.
    // Reject a look-alike policy rather than treating it as that frozen output.
    const canonicalHex = [t.actor, i.escrow, i.runtimeCodeHash, i.segmentId,
      i.sale.seller, i.sale.collection, i.sale.paymentToken, i.sale.buyer,
      ...correspondenceKeys.map(k => i.correspondence[k]),
      ...i.phases.flatMap(s => [s.calldataHash, s.planDigest, s.journalBindingHash])];
    if (canonicalHex.some(x => x !== x.toLowerCase())) refuse();
    const u = new URL(t.origin);
    if (u.origin !== t.origin || !(u.protocol === "https:" || u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) refuse();
    if (String(p.chainId) !== t.chainId || p.taskPrincipal.taskId !== t.taskId ||
        !same(p.request.account, t.actor) || !same(r.domain.verifyingContract, i.escrow) ||
        !same(r.segmentId, i.segmentId) || BigInt(t.fees.perOperationWei) > BigInt(t.fees.totalWei)) refuse();
    for (const k of ["seller", "collection", "paymentToken", "buyer"] as const) if (!same(r.sale[k], i.sale[k])) refuse();
    for (const k of ["tokenId", "price", "salt", "epoch"] as const) if (r.sale[k] !== i.sale[k]) refuse();
    if (String(r.sale.startsAt) !== i.sale.startsAt || String(r.sale.endsAt) !== i.sale.endsAt) refuse();
    for (const k of correspondenceKeys) if (!same(r.correspondence[k], i.correspondence[k])) refuse();
    const slots = i.phases;
    if (new Set(slots.map(s => s.phase)).size !== slots.length || new Set(slots.map(s => s.nonce)).size !== slots.length ||
        !slots.every((s, n) => BigInt(s.maxPriorityFeePerGasWei) <= BigInt(s.maxFeePerGasWei) &&
          BigInt(s.gasLimit) * BigInt(s.maxFeePerGasWei) <= BigInt(t.fees.perOperationWei) &&
          (s.phase !== "funded" || same(t.actor, i.sale.buyer)) &&
          (n === 0 || phases.indexOf(slots[n - 1]!.phase) < phases.indexOf(s.phase) && BigInt(slots[n - 1]!.nonce) < BigInt(s.nonce))) ||
        slots.reduce((sum, s) => sum + BigInt(s.gasLimit) * BigInt(s.maxFeePerGasWei), 0n) > BigInt(t.fees.totalWei)) refuse();
    const s = slots.find(s => s.phase === r.phase);
    if (!s || w.account !== t.actor || w.chainId !== t.chainId || w.to !== i.escrow || w.nonce !== s.nonce ||
        w.gasLimit !== s.gasLimit || w.maxFeePerGasWei !== s.maxFeePerGasWei ||
        w.maxPriorityFeePerGasWei !== s.maxPriorityFeePerGasWei || !same(keccak256(w.data as Hex), s.calldataHash)) refuse();
    // Re-encoding rejects appended ABI bytes, alternate offsets and any foreign
    // sale/correspondence hidden inside a registration payload.
    const decoded = decodeFunctionData({ abi, data: w.data as Hex });
    const trade = saleValues(r.sale), c = correspondenceValues(r.correspondence);
    let expected: Hex;
    if (r.phase === "funded" && decoded.functionName === "fund") {
      const signature = decoded.args[2];
      if (!/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(signature)) refuse();
      expected = encodeFunctionData({ abi, functionName: "fund", args: [trade, c, signature] });
    } else if (r.phase === "registered" && decoded.functionName === "confirmRegistration") {
      const [, ,version, proof] = decodeAbiParameters(evidence, decoded.args[1]);
      if (!r.kitRegistration || version < 2n || String(version) !== r.kitRegistration.version ||
          !/^0x(?:[0-9a-fA-F]{2}){1,4096}$/.test(proof) || !same(keccak256(proof), r.kitRegistration.proofHash)) refuse();
      const bytes = encodeAbiParameters(evidence, [trade, c, version, proof]);
      expected = encodeFunctionData({ abi, functionName: "confirmRegistration", args: [r.segmentId as Hex, bytes] });
    } else if (r.phase === "paid" && decoded.functionName === "paySeller") {
      expected = encodeFunctionData({ abi, functionName: "paySeller", args: [r.segmentId as Hex] });
    } else refuse();
    if (!same(expected, w.data)) refuse();
    // Do not expose the signature/proof/calldata through this unsigned result.
    return frozen({ ...projected, phaseSlot: structuredClone(s), runtimeCodeHash: i.runtimeCodeHash,
      authorization: "NOT_ESTABLISHED" as const });
  } catch { refuse(); }
}
