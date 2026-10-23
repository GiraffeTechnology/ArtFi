import "server-only";
import { z } from "zod";
import type { Address, Hex } from "viem";
import { receiptAuthorizationHash } from "./whole-receipt-authorization";
import {
  createNftTaskJournal,
  nftTaskJournalDigest,
  type NftTaskJournalConfig,
} from "./nft/task-journal";
import { NftError, type NftTaskPrincipal } from "./nft/model";
import type { NftOperation } from "./nft/journal";
import type { createWholeReceiptChainReader, createWholeReceiptRegistrationReader } from "./whole-receipt-chain";
import { assertReceiptOracleBinding } from "./whole-receipt-oracle-binding";
import {
  readWholeReceiptOracleObservation,
  readWholeReceiptOracleAttestation,
  type WholeReceiptAttestationPolicy,
} from "./oracle-read";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((x) => !/^0x0{40}$/i.test(x));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((x) => BigInt(x) < 2n ** 256n);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/);
const principal = z
  .object({
    kind: z.literal("task"),
    taskId: z.string(),
    taskDigest: z.string(),
    executorDigest: z.string(),
    grantReference: z.string(),
    grantPolicyVersion: z.string(),
    operationId: z.string(),
  })
  .strict();
const planSchema = z
  .object({
    id: identifier,
    operationId: identifier,
    chainId: z.union([z.literal(31337), z.literal(560048)]),
    taskPrincipal: principal,
    request: z.object({ account: address }).strict(),
    kind: z.literal("transaction"),
    wholeReceipt: z
      .object({
        schemaVersion: z.literal(1),
        phase: z.enum(["funded", "paid"]),
        segmentId: hash,
        domain: z
          .object({
            chainId: z.union([z.literal(31337), z.literal(560048)]),
            verifyingContract: address,
          })
          .strict(),
        sale: z
          .object({
            seller: address,
            buyer: address,
            collection: address,
            tokenId: uint,
            paymentToken: address,
            price: uint,
            salt: uint,
            epoch: uint,
            startsAt: z
              .number()
              .int()
              .nonnegative()
              .max(2 ** 48 - 1),
            endsAt: z
              .number()
              .int()
              .positive()
              .max(2 ** 48 - 1),
          })
          .strict(),
        correspondence: z
          .object({
            settlementId: hash,
            assetRecordHash: hash,
            oracleSourceId: hash,
            requestHash: hash,
            executionReferenceHash: hash,
            previousSegment: hash,
            oldCertificateHash: hash,
            warehouseReceiptHash: hash,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type WholeReceiptTaskPlan = z.infer<typeof planSchema>;
export type WholeReceiptTaskOperation = NftOperation<WholeReceiptTaskPlan>;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function invalid(): never {
  throw new NftError(422, "Invalid immutable whole-receipt journal plan.");
}
export function wholeReceiptTradeFromPlan(raw: unknown) {
  const plan = planSchema.parse(raw),
    r = plan.wholeReceipt,
    s = r.sale;
  const sale = {
    ...s,
    seller: s.seller as Address,
    buyer: s.buyer as Address,
    collection: s.collection as Address,
    paymentToken: s.paymentToken as Address,
    tokenId: BigInt(s.tokenId),
    price: BigInt(s.price),
    salt: BigInt(s.salt),
    epoch: BigInt(s.epoch),
  };
  const domain = {
    ...r.domain,
    verifyingContract: r.domain.verifyingContract as Address,
  };
  const correspondence = r.correspondence as Record<
    keyof typeof r.correspondence,
    Hex
  >;
  if (
    plan.chainId !== domain.chainId ||
    !same(
      receiptAuthorizationHash(sale, domain, correspondence),
      r.segmentId,
    ) ||
    (r.phase === "funded" && !same(plan.request.account, sale.buyer))
  )
    invalid();
  return { sale, domain, correspondence };
}
function checked(
  raw: WholeReceiptTaskOperation,
  expected?: WholeReceiptTaskPlan,
) {
  const plan = planSchema.parse(raw.plan);
  wholeReceiptTradeFromPlan(plan);
  if (
    raw.id !== plan.operationId ||
    raw.chainId !== plan.chainId ||
    !same(raw.wallet, plan.request.account) ||
    raw.requestHash !== nftTaskJournalDigest(plan) ||
    raw.orderHash !== undefined ||
    (expected && nftTaskJournalDigest(plan) !== nftTaskJournalDigest(expected))
  )
    invalid();
  return structuredClone({ ...raw, plan });
}

/** Reuses the existing authenticated task journal endpoint/table/CAS unchanged.
 * Records never contain signatures or raw transactions. This is composition code,
 * not a new credential, grant, endpoint, execution route or deployment setting.
 */
export function createWholeReceiptTaskJournal(
  config?: NftTaskJournalConfig<WholeReceiptTaskPlan>,
) {
  const journal = createNftTaskJournal<WholeReceiptTaskPlan>(config);
  async function read(
    task: NftTaskPrincipal,
    id: string,
    expected?: WholeReceiptTaskPlan,
  ) {
    return checked(await journal(task, "get", { id }), expected);
  }
  async function write(
    task: NftTaskPrincipal,
    current: WholeReceiptTaskOperation,
    change: Partial<WholeReceiptTaskOperation>,
  ) {
    const original = checked(current);
    const next = checked({ ...original, ...change }, original.plan);
    const result = checked(await journal(task, "update", next), original.plan);
    if (
      result.status !== next.status ||
      result.walletStarted !== next.walletStarted ||
      result.transactionHash !== next.transactionHash
    )
      invalid();
    return result;
  }
  async function reconcile(
    task: NftTaskPrincipal,
    id: string,
    chainReader: ReturnType<typeof createWholeReceiptChainReader>,
  ) {
    const current = await read(task, id);
    if (
      !current.walletStarted ||
      !current.transactionHash ||
      !["pending", "confirmed"].includes(current.status)
    )
      throw new NftError(409, "Canonical submission evidence is unavailable.");
    // Even a previously confirmed row requires fresh canonical evidence.
    const event = await chainReader(
      current.plan.wholeReceipt.phase,
      wholeReceiptTradeFromPlan(current.plan),
      current.transactionHash as Hex,
    );
    const operation =
      current.status === "confirmed"
        ? current
        : await write(task, current, { status: "confirmed" });
    return { operation, event };
  }
  return {
    read,
    reconcile,
    /** A public registration hash is a read hint, never a new task or payment
     * authorization. Derive all terms from a fresh authenticated journal read;
     * do not replace its funding/payment hash or persist a canonicality cache.
     */
    async observeRegistration(
      task: NftTaskPrincipal,
      id: string,
      transactionHash: Hex,
      registrationReader: ReturnType<typeof createWholeReceiptRegistrationReader>,
    ) {
      hash.parse(transactionHash);
      const operation = await read(task, id);
      const observation = await registrationReader(
        wholeReceiptTradeFromPlan(operation.plan),
        transactionHash,
      );
      return { operation, observation };
    },
    /** Reuses the same authenticated journal/signed preimage association before
     * observing an existing attestation. Its generic fact is not release authority.
     */
    async observeAttestation(
      task: NftTaskPrincipal,
      id: string,
      rawBinding: unknown,
      sourceId: string,
      policy: WholeReceiptAttestationPolicy,
    ) {
      const current = await read(task, id);
      const trade = wholeReceiptTradeFromPlan(current.plan);
      const binding = assertReceiptOracleBinding(
        rawBinding,
        sourceId,
        trade.sale,
        trade.domain.chainId,
        trade.correspondence,
      );
      return readWholeReceiptOracleAttestation(binding, policy);
    },
    /** A recovered public transaction hash is only a hint. Authenticate the
     * existing operation, prove its exact canonical receipt before recording,
     * then re-read/reverify after CAS. Never creates an operation, resets a
     * wallet-start marker, signs, broadcasts or retries an unknown wallet call.
     */
    async recoverSubmission(
      task: NftTaskPrincipal,
      id: string,
      transactionHash: Hex,
      chainReader: ReturnType<typeof createWholeReceiptChainReader>,
    ) {
      hash.parse(transactionHash);
      const current = await read(task, id);
      if (
        !current.walletStarted ||
        !["awaiting-wallet", "pending", "confirmed"].includes(current.status) ||
        (current.transactionHash &&
          !same(current.transactionHash, transactionHash)) ||
        (!current.transactionHash && current.status !== "awaiting-wallet")
      )
        throw new NftError(
          409,
          "Recover the existing immutable submission only.",
        );
      if (!current.transactionHash) {
        await chainReader(
          current.plan.wholeReceipt.phase,
          wholeReceiptTradeFromPlan(current.plan),
          transactionHash,
        );
        await write(task, current, { status: "pending", transactionHash });
      }
      // A reorg after initial verification must leave a pending, not confirmed,
      // record. A lost write response is recovered on a subsequent explicit read.
      return reconcile(task, id, chainReader);
    },
    /** Fresh authenticated journal read first; never accepts browser claims as
     * a replacement for signed commitments. Observation does not mutate lifecycle
     * or grant payment permission. Production source authentication is separate.
     */
    async observeOracle(
      task: NftTaskPrincipal,
      id: string,
      rawBinding: unknown,
      sourceId: string,
    ) {
      const current = await read(task, id);
      const trade = wholeReceiptTradeFromPlan(current.plan);
      const binding = assertReceiptOracleBinding(
        rawBinding,
        sourceId,
        trade.sale,
        trade.domain.chainId,
        trade.correspondence,
      );
      return readWholeReceiptOracleObservation(binding);
    },
    async create(task: NftTaskPrincipal, raw: WholeReceiptTaskPlan) {
      const plan = planSchema.parse(raw);
      wholeReceiptTradeFromPlan(plan);
      const operation: WholeReceiptTaskOperation = {
        id: plan.operationId,
        wallet: plan.request.account,
        chainId: plan.chainId,
        plan,
        requestHash: nftTaskJournalDigest(plan),
        revision: 0,
        status: "awaiting-wallet",
        walletStarted: false,
        updatedAt: "",
      };
      // Existing server create is exact-idempotent and returns an existing record.
      // Its current lifecycle must be recovered, never reset to awaiting-wallet.
      return checked(await journal(task, "create", operation), plan);
    },
    async markWalletStarted(
      task: NftTaskPrincipal,
      current: WholeReceiptTaskOperation,
    ) {
      if (
        current.status !== "awaiting-wallet" ||
        current.walletStarted ||
        current.transactionHash
      )
        throw new NftError(
          409,
          "Recover the existing wallet operation before continuing.",
        );
      return write(task, current, { walletStarted: true });
    },
    async recordSubmission(
      task: NftTaskPrincipal,
      current: WholeReceiptTaskOperation,
      transactionHash: Hex,
    ) {
      hash.parse(transactionHash);
      if (!current.walletStarted)
        throw new NftError(409, "The wallet operation has not started.");
      if (current.transactionHash) {
        if (!same(current.transactionHash, transactionHash))
          throw new NftError(
            409,
            "The submitted transaction cannot be replaced.",
          );
        return read(task, current.id, current.plan);
      }
      if (current.status !== "awaiting-wallet")
        throw new NftError(
          409,
          "Recover the existing wallet operation before continuing.",
        );
      return write(task, current, { status: "pending", transactionHash });
    },
  };
}
