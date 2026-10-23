import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const oracleRead = vi.hoisted(() => vi.fn());
const attestationRead = vi.hoisted(() => vi.fn());
vi.mock("./oracle-read", () => ({
  readWholeReceiptOracleObservation: oracleRead,
  readWholeReceiptOracleAttestation: attestationRead,
}));
import { receiptOracleCommitments } from "./whole-receipt-oracle-binding";
import {
  createWholeReceiptTaskJournal,
  wholeReceiptTradeFromPlan,
  type WholeReceiptTaskOperation,
  type WholeReceiptTaskPlan,
} from "./whole-receipt-journal";
import { receiptAuthorizationHash } from "./whole-receipt-authorization";
import {
  nftTaskJournalDigest,
  type NftTaskJournalConfig,
} from "./nft/task-journal";
import type { NftTaskPrincipal } from "./nft/model";
import type { Hex, Address } from "viem";
const a = (s: string) => `0x${s.repeat(40)}` as Address,
  h = (s: string) => `0x${s.repeat(64)}` as Hex;
const task: NftTaskPrincipal = {
  kind: "task",
  taskId: "TEST_ONLY",
  taskDigest: h("1"),
  executorDigest: h("2"),
  grantReference: "grant:TEST_ONLY",
  grantPolicyVersion: "1",
  operationId: "TEST_ONLY_wallet_operation",
};
function plan(): WholeReceiptTaskPlan {
  const sale = {
    seller: a("a"),
    buyer: a("b"),
    collection: a("1"),
    paymentToken: a("2"),
    tokenId: 7n,
    price: 100n,
    salt: 1n,
    epoch: 0n,
    startsAt: 1000,
    endsAt: 2000,
  };
  const domain = { chainId: 560048 as const, verifyingContract: a("3") };
  const correspondence = {
    settlementId: h("1"),
    assetRecordHash: h("2"),
    oracleSourceId: h("3"),
    requestHash: h("4"),
    executionReferenceHash: h("5"),
    previousSegment: h("0"),
    oldCertificateHash: h("6"),
    warehouseReceiptHash: h("7"),
  };
  return {
    id: "TEST_ONLY_receipt_plan",
    operationId: "TEST_ONLY_receipt_operation",
    chainId: 560048,
    taskPrincipal: task,
    request: { account: sale.buyer },
    kind: "transaction",
    wholeReceipt: {
      schemaVersion: 1,
      phase: "funded",
      segmentId: receiptAuthorizationHash(sale, domain, correspondence),
      domain,
      correspondence,
      sale: { ...sale, tokenId: "7", price: "100", salt: "1", epoch: "0" },
    },
  };
}

it("authenticates the stored operation and checks signed preimages before observing Oracle without a journal write", async () => {
  oracleRead.mockReset().mockResolvedValue({
    observationOnly: true,
    sourceAuthenticatedForPayment: false,
  });
  const f = fixture(),
    j = f.client(),
    p = plan();
  const binding = {
    settlementId: "TEST_ONLY-settlement",
    assetId: "TEST_ONLY-asset",
    token: {
      chainId: "560048",
      contract: p.wholeReceipt.sale.collection,
      tokenId: "7",
    },
    sellerWallet: p.wholeReceipt.sale.seller,
    buyerWallet: p.wholeReceipt.sale.buyer,
    externalExecutionRef: "TEST_ONLY-execution",
    oldCertificateHash: "1".repeat(64),
    warehouseReceiptHash: "2".repeat(64),
    snapshotHash: "3".repeat(64),
  };
  const source = "TEST_ONLY-Oracle";
  p.wholeReceipt.correspondence = {
    ...receiptOracleCommitments(binding, source),
    previousSegment: h("0"),
  };
  const trade = {
    ...p.wholeReceipt.sale,
    tokenId: 7n,
    price: 100n,
    salt: 1n,
    epoch: 0n,
    seller: a("a"),
    buyer: a("b"),
    collection: a("1"),
    paymentToken: a("2"),
  };
  p.wholeReceipt.segmentId = receiptAuthorizationHash(
    trade,
    { ...p.wholeReceipt.domain, verifyingContract: a("3") },
    p.wholeReceipt.correspondence as Parameters<
      typeof receiptAuthorizationHash
    >[2],
  );
  const row = await j.create(task, p);
  await expect(
    j.observeOracle(
      task,
      row.id,
      { ...binding, externalExecutionRef: "OTHER" },
      source,
    ),
  ).rejects.toThrow("RECEIPT_ORACLE_SIGNED_BINDING_MISMATCH");
  expect(oracleRead).not.toHaveBeenCalled();
  expect(await j.observeOracle(task, row.id, binding, source)).toEqual({
    observationOnly: true,
    sourceAuthenticatedForPayment: false,
  });
  expect(oracleRead).toHaveBeenCalledWith(binding);
  expect(f.calls).toEqual(["create", "get", "get"]);
  const policy = {
    attestationId: "00000000-0000-4000-8000-000000000001",
    purpose: "provenance",
    signerSetId: "TEST_ONLY-set",
    sourceAuthority: "TEST_ONLY-CA",
    sourceRecordHash: "a".repeat(64),
    factType: "CERTIFICATE_STATUS" as const,
    factValue: "VALID",
  };
  attestationRead.mockReset().mockResolvedValue({
    observationOnly: true,
    sourceAuthenticatedForPayment: false,
  });
  await expect(
    j.observeAttestation(
      task,
      row.id,
      { ...binding, buyerWallet: a("c") },
      source,
      policy,
    ),
  ).rejects.toThrow();
  expect(attestationRead).not.toHaveBeenCalled();
  await j.observeAttestation(task, row.id, binding, source, policy);
  expect(attestationRead).toHaveBeenCalledWith(binding, policy);
  expect(f.calls).toEqual(["create", "get", "get", "get", "get"]);
});
/** Synthetic shared-store wire fixture, NOT a MySQL/mTLS acceptance result. */
function fixture() {
  let stored: WholeReceiptTaskOperation | undefined,
    gate = false,
    loseNextResponse = false;
  const calls: string[] = [];
  const config: NftTaskJournalConfig<WholeReceiptTaskPlan> = {
    url: "https://journal.invalid/internal/v1/nft/operations",
    peerId: "spiffe://TEST_ONLY/journal",
    async withCapability(scope, dispatch) {
      expect(scope.principal).toEqual(task);
      expect(scope.requestDigest).toBe(
        nftTaskJournalDigest({
          action: scope.action,
          operation: scope.operation,
        }),
      );
      gate = true;
      try {
        return await dispatch("TEST_ONLY_opaque_capability_not_a_credential");
      } finally {
        gate = false;
      }
    },
    async transport(_url, init) {
      expect(gate).toBe(true);
      const { action, operation } = JSON.parse(String(init.body));
      calls.push(action);
      if (action === "get")
        return stored
          ? Response.json(stored)
          : new Response(null, { status: 404 });
      if (action === "create") {
        if (
          stored &&
          nftTaskJournalDigest(stored.plan) !==
            nftTaskJournalDigest(operation.plan)
        )
          return new Response(null, { status: 409 });
        stored ??= {
          ...operation,
          revision: 1,
          updatedAt: "2026-10-12T00:00:00Z",
        };
      } else {
        if (
          !stored ||
          operation.revision !== stored.revision ||
          nftTaskJournalDigest(stored.plan) !==
            nftTaskJournalDigest(operation.plan)
        )
          return new Response(null, { status: 409 });
        stored = {
          ...operation,
          revision: stored.revision + 1,
          updatedAt: "2026-10-12T00:01:00Z",
        };
      }
      if (loseNextResponse) {
        loseNextResponse = false;
        throw Error("TEST_ONLY_LOST_RESPONSE");
      }
      return Response.json(stored);
    },
  };
  return {
    config,
    calls,
    client: () => createWholeReceiptTaskJournal(config),
    snapshot: () => structuredClone(stored!),
    set: (row: WholeReceiptTaskOperation) => {
      stored = row;
    },
    loseNext: () => {
      loseNextResponse = true;
    },
  };
}
describe("TEST_ONLY whole-receipt task journal integration", () => {
  describe("registration receipt association", () => {
    const observation = () => ({
      kind: "registration-confirmed-onchain" as const,
      segmentId: plan().wholeReceipt.segmentId as Hex,
      recordHash: h("9"),
      reference: "TEST_ONLY_registration",
      blockNumber: 20n,
      blockHash: h("8"),
      transactionHash: h("7"),
      oracleEvidenceAuthenticated: false as const,
    });
    it("uses the authenticated immutable trade across clients without a lifecycle write", async () => {
      const f = fixture(), p = plan(), row = await f.client().create(task, p);
      const before = f.snapshot(), reader = vi.fn(async () => observation());
      const result = await f.client().observeRegistration(task, row.id, h("7"), reader);
      expect(result.operation).toEqual(row);
      expect(result.observation).toEqual(observation());
      expect(result.observation.oracleEvidenceAuthenticated).toBe(false);
      expect(reader).toHaveBeenCalledWith(wholeReceiptTradeFromPlan(p), h("7"));
      expect(f.snapshot()).toEqual(before);
      expect(f.calls).toEqual(["create", "get"]);
      await f.client().observeRegistration(task, row.id, h("7"), reader);
      expect(reader).toHaveBeenCalledTimes(2);
      expect(f.calls).toEqual(["create", "get", "get"]);
    });
    it("rejects a malformed transaction hint before journal or chain access", async () => {
      const f = fixture(), reader = vi.fn(async () => observation());
      await expect(f.client().observeRegistration(task, "TEST_ONLY_missing", "0x1234", reader)).rejects.toThrow();
      expect(f.calls).toEqual([]);
      expect(reader).not.toHaveBeenCalled();
    });
    it("does not bypass a rejected capability", async () => {
      const f = fixture(), row = await f.client().create(task, plan());
      f.config.withCapability = async () => { throw Error("TEST_ONLY_CAPABILITY_DENIED"); };
      const reader = vi.fn(async () => observation());
      await expect(f.client().observeRegistration(task, row.id, h("7"), reader)).rejects.toThrow();
      expect(reader).not.toHaveBeenCalled();
      expect(f.calls).toEqual(["create"]);
    });
    it("rejects signed-term drift from storage before chain access", async () => {
      const f = fixture(), row = await f.client().create(task, plan());
      const drift = structuredClone(row);
      drift.plan.wholeReceipt.sale.price = "101";
      drift.requestHash = nftTaskJournalDigest(drift.plan);
      f.set(drift);
      const reader = vi.fn(async () => observation());
      await expect(f.client().observeRegistration(task, row.id, h("7"), reader)).rejects.toThrow();
      expect(reader).not.toHaveBeenCalled();
    });
    it.each(["TEST_ONLY_REORG", "TEST_ONLY_WRONG_SEGMENT"])("propagates %s without changing the operation", async (failure) => {
      const f = fixture(), row = await f.client().create(task, plan()), before = f.snapshot();
      const reader = vi.fn(async () => { throw Error(failure); });
      await expect(f.client().observeRegistration(task, row.id, h("7"), reader)).rejects.toThrow(failure);
      expect(f.snapshot()).toEqual(before);
      expect(f.calls).toEqual(["create", "get"]);
    });
  });
  function proof(p: WholeReceiptTaskPlan) {
    return p.wholeReceipt.phase === "paid"
      ? {
          kind: "paid" as const,
          segmentId: p.wholeReceipt.segmentId,
          reference: "TEST_ONLY_paid",
        }
      : {
          kind: "funded" as const,
          trade: {
            id: p.wholeReceipt.segmentId,
            seller: a("a"),
            buyer: a("b"),
            paymentToken: a("2"),
            amount: 100n,
            escrowReference: "TEST_ONLY_fund",
            ownerTransferReference: "TEST_ONLY_nft",
          },
        };
  }
  it.each(["funded", "paid"] as const)(
    "recovers lost %s submission after exact chain verification across clients",
    async (phase) => {
      const f = fixture(),
        p = plan();
      p.wholeReceipt.phase = phase;
      const j = f.client(),
        created = await j.create(task, p);
      await j.markWalletStarted(task, created);
      const reader = vi.fn(async () => proof(p));
      const recovered = await f
        .client()
        .recoverSubmission(task, created.id, h("a"), reader);
      expect(recovered.operation.status).toBe("confirmed");
      expect(recovered.operation.transactionHash).toBe(h("a"));
      expect(recovered.operation.walletStarted).toBe(true);
      expect(reader).toHaveBeenCalledTimes(2);
      expect(reader).toHaveBeenNthCalledWith(
        1,
        phase,
        wholeReceiptTradeFromPlan(p),
        h("a"),
      );
      const writes = f.calls.filter((x) => x === "update").length;
      await f.client().recoverSubmission(task, created.id, h("a"), reader);
      expect(reader).toHaveBeenCalledTimes(3);
      expect(f.calls.filter((x) => x === "update")).toHaveLength(writes);
    },
  );
  it("does not accept an unverified hash or invent a wallet-started operation", async () => {
    const f = fixture(),
      j = f.client(),
      row = await j.create(task, plan());
    const reader = vi.fn(async () => {
      throw Error("TEST_ONLY_WRONG_RECEIPT");
    });
    await expect(
      j.recoverSubmission(task, row.id, h("a"), reader),
    ).rejects.toMatchObject({ status: 409 });
    expect(reader).not.toHaveBeenCalled();
    await j.markWalletStarted(task, row);
    const before = f.snapshot();
    await expect(
      j.recoverSubmission(task, row.id, h("a"), reader),
    ).rejects.toThrow("TEST_ONLY_WRONG_RECEIPT");
    expect(f.snapshot()).toEqual(before);
  });
  it("leaves a pending immutable hash when canonicality changes after recording", async () => {
    const f = fixture(),
      j = f.client(),
      p = plan(),
      row = await j.create(task, p);
    await j.markWalletStarted(task, row);
    const reader = vi
      .fn()
      .mockResolvedValueOnce(proof(p))
      .mockRejectedValueOnce(Error("TEST_ONLY_REORG"));
    await expect(
      j.recoverSubmission(task, row.id, h("a"), reader),
    ).rejects.toThrow("TEST_ONLY_REORG");
    expect(f.snapshot()).toMatchObject({
      status: "pending",
      transactionHash: h("a"),
      walletStarted: true,
    });
    reader.mockClear();
    await expect(
      j.recoverSubmission(task, row.id, h("b"), reader),
    ).rejects.toMatchObject({ status: 409 });
    expect(reader).not.toHaveBeenCalled();
  });
  it("recovers a lost journal update response without repeating a write or wallet action", async () => {
    const f = fixture(),
      j = f.client(),
      p = plan(),
      row = await j.create(task, p);
    await j.markWalletStarted(task, row);
    const reader = vi.fn(async () => proof(p));
    f.loseNext();
    await expect(
      j.recoverSubmission(task, row.id, h("a"), reader),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.snapshot()).toMatchObject({
      status: "pending",
      transactionHash: h("a"),
    });
    const result = await f
      .client()
      .recoverSubmission(task, row.id, h("a"), reader);
    expect(result.operation.status).toBe("confirmed");
    expect(f.calls.filter((x) => x === "update")).toHaveLength(3); // start, pending, confirmed
  });
  it("rejects a stale recovery CAS when another replica records a different hash", async () => {
    const f = fixture(),
      j = f.client(),
      p = plan(),
      row = await j.create(task, p);
    await j.markWalletStarted(task, row);
    const reader = vi.fn(async () => {
      await f.client().recordSubmission(task, f.snapshot(), h("b"));
      return proof(p);
    });
    await expect(
      j.recoverSubmission(task, row.id, h("a"), reader),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.snapshot()).toMatchObject({
      status: "pending",
      transactionHash: h("b"),
    });
  });
  it("reuses the capability endpoint and recovers immutable terms across clients", async () => {
    const f = fixture(),
      first = f.client();
    const created = await first.create(task, plan());
    expect(created.revision).toBe(1);
    expect(await f.client().read(task, created.id)).toEqual(created);
    expect(wholeReceiptTradeFromPlan(created.plan).sale.price).toBe(100n);
    expect(f.calls).toEqual(["create", "get"]);
  });
  it("preserves submitted transaction on repeated create and does not restart wallet", async () => {
    const f = fixture(),
      j = f.client();
    let row = await j.create(task, plan());
    row = await j.markWalletStarted(task, row);
    row = await j.recordSubmission(task, row, h("a"));
    const restored = await f.client().create(task, plan());
    expect(restored).toEqual(row);
    await expect(j.markWalletStarted(task, restored)).rejects.toMatchObject({
      status: 409,
    });
    expect(await j.recordSubmission(task, restored, h("a"))).toEqual(row);
    await expect(
      j.recordSubmission(task, restored, h("b")),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("does not reissue an outcome-unknown CAS; read recovers durable result", async () => {
    const f = fixture(),
      j = f.client();
    const row = await j.create(task, plan());
    f.loseNext();
    await expect(j.markWalletStarted(task, row)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.calls).toEqual(["create", "update"]);
    const recovered = await f.client().read(task, row.id);
    expect(recovered.walletStarted).toBe(true);
    expect(recovered.revision).toBe(2);
    await expect(j.markWalletStarted(task, recovered)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("rejects concurrent stale revision instead of authorizing a second operation", async () => {
    const f = fixture(),
      j = f.client(),
      row = await j.create(task, plan());
    await j.markWalletStarted(task, row);
    await expect(f.client().markWalletStarted(task, row)).rejects.toMatchObject(
      { status: 409 },
    );
  });
  it("requires fresh canonical chain evidence even for a previously confirmed row", async () => {
    const f = fixture(),
      j = f.client();
    let row = await j.create(task, plan());
    row = await j.markWalletStarted(task, row);
    row = await j.recordSubmission(task, row, h("a"));
    const event = {
      kind: "funded" as const,
      trade: {
        id: row.plan.wholeReceipt.segmentId,
        seller: a("a"),
        buyer: a("b"),
        paymentToken: a("2"),
        amount: 100n,
        escrowReference: "TEST_ONLY_fund",
        ownerTransferReference: "TEST_ONLY_nft",
      },
    };
    const reader = vi.fn(async () => event);
    expect((await j.reconcile(task, row.id, reader)).operation.status).toBe(
      "confirmed",
    );
    expect(reader).toHaveBeenCalledWith(
      "funded",
      wholeReceiptTradeFromPlan(row.plan),
      h("a"),
    );
    reader.mockRejectedValue(Error("TEST_ONLY_REORG"));
    await expect(j.reconcile(task, row.id, reader)).rejects.toThrow(
      "TEST_ONLY_REORG",
    );
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("never promotes missing transaction or failed chain evidence", async () => {
    const f = fixture(),
      j = f.client();
    let row = await j.create(task, plan());
    const reader = vi.fn(async () => {
      throw Error("TEST_ONLY_BAD_RECEIPT");
    });
    await expect(j.reconcile(task, row.id, reader)).rejects.toMatchObject({
      status: 409,
    });
    expect(reader).not.toHaveBeenCalled();
    await expect(j.recordSubmission(task, row, h("a"))).rejects.toMatchObject({
      status: 409,
    });
    row = await j.markWalletStarted(task, row);
    row = await j.recordSubmission(task, row, h("a"));
    await expect(j.reconcile(task, row.id, reader)).rejects.toThrow();
    expect(f.snapshot().status).toBe("pending");
  });
  it("rejects foreign task/session and secret-bearing or altered plans before dispatch", async () => {
    for (const mutate of [
      (p: WholeReceiptTaskPlan) => {
        p.taskPrincipal = { ...task, taskId: "FOREIGN" };
      },
      (p: WholeReceiptTaskPlan) => {
        Object.assign(p, { sessionId: "TEST_ONLY" });
      },
      (p: WholeReceiptTaskPlan) => {
        Object.assign(p, { signature: "TEST_ONLY" });
      },
      (p: WholeReceiptTaskPlan) => {
        p.wholeReceipt.sale.price = "101";
      },
      (p: WholeReceiptTaskPlan) => {
        p.wholeReceipt.sale.price = (2n ** 256n).toString();
      },
      (p: WholeReceiptTaskPlan) => {
        p.request.account = a("c");
      },
      (p: WholeReceiptTaskPlan) => {
        p.wholeReceipt.correspondence.requestHash = h("e");
      },
    ]) {
      const f = fixture(),
        p = plan();
      mutate(p);
      await expect(f.client().create(task, p)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    }
  });
  it("rejects drift from storage on get even if its new digest is self-consistent", async () => {
    const f = fixture(),
      j = f.client(),
      row = await j.create(task, plan());
    const changed = structuredClone(row);
    changed.plan.wholeReceipt.sale.price = "101";
    changed.requestHash = nftTaskJournalDigest(changed.plan);
    f.set(changed);
    await expect(j.read(task, row.id)).rejects.toThrow();
  });
  it("does not accept a runtime response that silently drops the submitted hash", async () => {
    const f = fixture(),
      j = f.client();
    let row = await j.create(task, plan());
    row = await j.markWalletStarted(task, row);
    const original = f.config.transport;
    f.config.transport = async (url, init) => {
      const response = await original(url, init);
      const body = await response.json();
      delete body.transactionHash;
      return Response.json(body);
    };
    await expect(
      f.client().recordSubmission(task, row, h("a")),
    ).rejects.toThrow();
  });
  it("fails closed without configured authenticated transport", async () => {
    await expect(
      createWholeReceiptTaskJournal().create(task, plan()),
    ).rejects.toMatchObject({ status: 503 });
  });
});
