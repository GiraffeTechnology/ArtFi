import { describe, expect, it, vi } from "vitest";
import {
  keccak256,
  stringToHex,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  checkDaoTransaction,
  createDaoActionSession,
  daoActionSession,
  isDaoWalletRejection,
  loadSubmittedDaoProposal,
  proposalPackageId,
  saveSubmittedDaoProposal,
  type DaoTransaction,
  type ProposalPackage,
} from "./dao-action-state";

const hash = `0x${"11".repeat(32)}` as Hash;
const replacement = `0x${"22".repeat(32)}` as Hash;
const target = "0x1000000000000000000000000000000000000001";
const description = "Existing proposal description";
const base = {
  description,
  targets: [target] as const,
  values: [0n] as const,
  calldatas: ["0x12345678"] as const,
  descriptionHash: keccak256(stringToHex(description)),
};
const proposal: ProposalPackage = {
  ...base,
  proposalId: proposalPackageId(base),
};
const transaction: DaoTransaction = {
  hash,
  success: "Proposal queued in the Timelock.",
  phase: "pending",
};
const account = "0x2000000000000000000000000000000000000002";
const blockHash = `0x${"33".repeat(32)}` as Hash;
const binding: Parameters<typeof checkDaoTransaction>[0]["binding"] = {
  chainId: 560048,
  account,
  targets: [target],
};
const receipt = (
  status: "success" | "reverted" = "success",
  transactionHash = hash,
) =>
  ({
    status,
    transactionHash,
    blockNumber: 77n,
    blockHash,
    logs: [],
  }) as unknown as TransactionReceipt;
const client = (wait: ReturnType<typeof vi.fn>) =>
  ({
    waitForTransactionReceipt: wait,
    getChainId: async () => 560048,
    getBlock: async () => ({ number: 77n, hash: blockHash }),
    getTransaction: async ({ hash }: { hash: Hash }) => ({
      hash,
      chainId: 560048,
      from: account,
      to: target,
      value: 0n,
      nonce: 7,
      input: "0x12345678",
    }),
  }) as unknown as Parameters<typeof checkDaoTransaction>[0]["client"];
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("DAO transaction outcomes", () => {
  it("keeps a queue hash pending until its successful receipt", async () => {
    let resolve!: (value: TransactionReceipt) => void;
    const promise = new Promise<TransactionReceipt>((done) => {
      resolve = done;
    });
    const states: DaoTransaction[] = [];
    const running = checkDaoTransaction({
      binding,
      client: client(vi.fn().mockReturnValue(promise)),
      transaction,
      isCurrent: () => true,
      update: (state) => states.push(state),
    });
    expect(states.map((state) => state.phase)).toEqual(["pending"]);
    resolve(receipt());
    await running;
    expect(states.map((state) => state.phase)).toEqual([
      "pending",
      "confirmed",
    ]);
  });
  it("reports a reverted receipt as failed", async () => {
    const update = vi.fn();
    const result = await checkDaoTransaction({
      binding,
      client: client(vi.fn().mockResolvedValue(receipt("reverted"))),
      transaction,
      isCurrent: () => true,
      update,
    });
    expect(result.phase).toBe("failed");
    expect(result.error).toContain("reverted");
    expect(update).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "confirmed" }),
    );
  });
  it("keeps an unavailable receipt unresolved and allows a read-only recheck", async () => {
    const update = vi.fn();
    const first = await checkDaoTransaction({
      binding,
      client: client(vi.fn().mockRejectedValue(new Error("timeout"))),
      transaction,
      isCurrent: () => true,
      update,
    });
    expect(first.phase).toBe("unknown");
    const retried = await checkDaoTransaction({
      binding,
      client: client(vi.fn().mockResolvedValue(receipt())),
      transaction: first,
      isCurrent: () => true,
      update,
    });
    expect(retried.phase).toBe("confirmed");
    expect(retried.hash).toBe(hash);
  });
  it.each(["cancelled", "replaced"])(
    "never marks a %s transaction successful",
    async (reason) => {
      const result = await checkDaoTransaction({
        binding,
        client: client(
          vi.fn().mockImplementation(async ({ onReplaced }) => {
            onReplaced({
              reason,
              transactionReceipt: receipt("success", replacement),
            });
            return receipt("success", replacement);
          }),
        ),
        transaction,
        isCurrent: () => true,
        update: vi.fn(),
      });
      expect(result.phase).toBe("failed");
      expect(result.error).toContain("cancelled or replaced");
    },
  );
  it("retains the replacement hash for a repriced identical operation", async () => {
    const onHash = vi.fn();
    const result = await checkDaoTransaction({
      binding,
      client: client(
        vi.fn().mockImplementation(async ({ onReplaced }) => {
          onReplaced({
            reason: "repriced",
            transactionReceipt: receipt("success", replacement),
          });
          return receipt("success", replacement);
        }),
      ),
      transaction,
      isCurrent: () => true,
      update: vi.fn(),
      onHash,
    });
    expect(result.phase).toBe("confirmed");
    expect(result.hash).toBe(replacement);
    expect(onHash).toHaveBeenCalledWith(replacement);
  });
  it("does not publish confirmation into a changed wallet or deployment", async () => {
    let current = true;
    let resolve!: (value: TransactionReceipt) => void;
    const promise = new Promise<TransactionReceipt>((done) => {
      resolve = done;
    });
    const update = vi.fn();
    const running = checkDaoTransaction({
      binding,
      client: client(vi.fn().mockReturnValue(promise)),
      transaction,
      isCurrent: () => current,
      update,
    });
    current = false;
    resolve(receipt());
    await running;
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "pending" }),
    );
  });
});

describe("browser recovery of the last submitted proposal", () => {
  it("restores bigint calldata packages after reload without signatures or authorization", () => {
    const store = storage();
    saveSubmittedDaoProposal(store, "chain:wallet:deployment", {
      proposal,
      transactionHash: hash,
    });
    expect(
      loadSubmittedDaoProposal(store, "chain:wallet:deployment", target),
    ).toEqual({ proposal, transactionHash: hash });
    expect(store.values.values().next().value).not.toContain("signature");
    expect(
      loadSubmittedDaoProposal(store, "chain:other-wallet:deployment", target),
    ).toBeUndefined();
    expect(
      loadSubmittedDaoProposal(store, "other-chain:wallet:deployment", target),
    ).toBeUndefined();
    expect(
      loadSubmittedDaoProposal(store, "chain:wallet:other-deployment", target),
    ).toBeUndefined();
  });
  it("keeps only the last submitted package for a context", () => {
    const store = storage();
    saveSubmittedDaoProposal(store, "context", {
      proposal,
      transactionHash: hash,
    });
    saveSubmittedDaoProposal(store, "context", {
      proposal,
      transactionHash: replacement,
    });
    expect(store.values.size).toBe(1);
    expect(
      loadSubmittedDaoProposal(store, "context", target)?.transactionHash,
    ).toBe(replacement);
  });
  it.each([
    "corrupt",
    "description",
    "proposalId",
    "target",
    "value",
    "calldata",
    "transactionHash",
    "oversized",
  ])("rejects %s recovery data", (change) => {
    const store = storage();
    saveSubmittedDaoProposal(store, "context", {
      proposal,
      transactionHash: hash,
    });
    const key = "artfi:dao-proposal:context";
    const saved = JSON.parse(store.getItem(key)!);
    if (change === "description")
      saved.proposal.description = "A substituted description";
    if (change === "proposalId") saved.proposal.proposalId = "1";
    if (change === "target")
      saved.proposal.targets = ["0x2000000000000000000000000000000000000002"];
    if (change === "value") saved.proposal.values = ["1"];
    if (change === "calldata") saved.proposal.calldatas = ["0x76543210"];
    if (change === "transactionHash") saved.transactionHash = "bad";
    store.setItem(
      key,
      change === "corrupt"
        ? "{"
        : change === "oversized"
          ? "a".repeat(48_001)
          : JSON.stringify(saved),
    );
    expect(() => loadSubmittedDaoProposal(store, "context", target)).toThrow(
      "invalid",
    );
  });
  it("surfaces storage failure instead of claiming recovery exists", () => {
    expect(() =>
      saveSubmittedDaoProposal(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        "context",
        { proposal, transactionHash: hash },
      ),
    ).toThrow("quota");
  });
});

describe("same-tab DAO request coordination across mounts", () => {
  it("blocks a second wallet request before the first hash and publishes it to a returned subscriber", () => {
    const store = storage();
    const context = `remount-${crypto.randomUUID()}`;
    const original = daoActionSession(context);
    const lease = original.begin()!;
    original.awaitWallet(lease, () => store);
    const returned = daoActionSession(context);
    const updates = vi.fn();
    const unsubscribe = returned.subscribe(updates);
    expect(returned.getSnapshot()).toMatchObject({
      busy: true,
      awaitingWallet: true,
    });
    expect(returned.begin()).toBeUndefined();
    expect(
      original.broadcast(
        lease,
        { ...transaction, proposalCreation: true },
        proposal,
        () => store,
      ),
    ).toBe(true);
    expect(updates).toHaveBeenCalled();
    expect(returned.getSnapshot()).toMatchObject({
      transaction,
      submitted: { proposal, transactionHash: hash },
      awaitingWallet: false,
    });
    original.updateTransaction(
      lease,
      hash,
      { ...transaction, phase: "confirmed" },
      () => store,
    );
    original.finish(lease);
    expect(returned.getSnapshot().busy).toBe(false);
    expect(returned.begin()).toBeDefined();
    unsubscribe();
  });

  it("does not replace a live prompt with an older saved package during remount", () => {
    const store = storage();
    const context = "restore-live";
    saveSubmittedDaoProposal(store, context, {
      proposal,
      transactionHash: replacement,
    });
    const session = createDaoActionSession(context);
    const lease = session.begin()!;
    session.awaitWallet(lease, () => store);
    session.restore(() => store, target);
    expect(session.getSnapshot()).toMatchObject({
      busy: true,
      awaitingWallet: true,
    });
    expect(session.getSnapshot().transaction).toBeUndefined();
    expect(session.getSnapshot().submitted).toBeUndefined();
  });

  it("rejects stale broadcast, repricing, completion and lock release after a later operation begins", () => {
    const store = storage();
    const session = createDaoActionSession("generation-check");
    const old = session.begin()!;
    session.awaitWallet(old, () => store);
    session.broadcast(
      old,
      { ...transaction, proposalCreation: true },
      proposal,
      () => store,
    );
    session.updateTransaction(
      old,
      hash,
      { ...transaction, phase: "confirmed" },
      () => store,
    );
    session.finish(old);
    const next = session.begin()!;
    session.awaitWallet(next, () => store);
    session.broadcast(
      next,
      { ...transaction, hash: replacement, proposalCreation: true },
      proposal,
      () => store,
    );
    const before = new Map(store.values);
    expect(session.broadcast(old, transaction, proposal, () => store)).toBe(
      false,
    );
    expect(session.replaceHash(old, hash, hash, () => store)).toBe(false);
    expect(
      session.updateTransaction(
        old,
        hash,
        { ...transaction, phase: "failed" },
        () => store,
      ),
    ).toBe(false);
    session.fail(old, "old error", true, () => store);
    session.finish(old);
    expect(session.getSnapshot()).toMatchObject({
      busy: true,
      transaction: { hash: replacement },
      actionError: "",
    });
    expect(store.values).toEqual(before);
    expect(session.begin()).toBeUndefined();
  });

  it("requires the matching current hash even for a valid operation lease", () => {
    const store = storage();
    const session = createDaoActionSession("hash-check");
    const lease = session.begin()!;
    session.awaitWallet(lease, () => store);
    session.broadcast(
      lease,
      { ...transaction, proposalCreation: true },
      proposal,
      () => store,
    );
    expect(session.replaceHash(lease, replacement, hash, () => store)).toBe(
      false,
    );
    expect(
      session.updateTransaction(
        lease,
        hash,
        { ...transaction, hash: replacement, phase: "confirmed" },
        () => store,
      ),
    ).toBe(false);
    expect(session.replaceHash(lease, hash, replacement, () => store)).toBe(
      true,
    );
    expect(
      loadSubmittedDaoProposal(store, "hash-check", target)?.transactionHash,
    ).toBe(replacement);
    expect(
      JSON.parse(store.getItem("artfi:dao-pending:hash-check")!).hash,
    ).toBe(replacement);
  });

  it("isolates wallet, chain and deployment contexts", () => {
    const store = storage();
    const base = `isolation-${crypto.randomUUID()}`;
    const a = daoActionSession(`${base}:hoodi:wallet-a:governor-a`);
    const lease = a.begin()!;
    a.awaitWallet(lease, () => store);
    for (const context of [
      `${base}:hoodi:wallet-b:governor-a`,
      `${base}:other-chain:wallet-a:governor-a`,
      `${base}:hoodi:wallet-a:governor-b`,
    ]) {
      const other = daoActionSession(context);
      other.restore(() => store, target);
      expect(other.begin()).toBeDefined();
    }
    expect(a.begin()).toBeUndefined();
  });
});

describe("minimal DAO interruption recovery", () => {
  it.each(["vote", "delegate", "queue", "execute"])(
    "keeps a broadcast %s unresolved after a hard reload without needing a proposal package",
    (kind) => {
      const store = storage();
      const context = `reload-${kind}`;
      const first = createDaoActionSession(context);
      const lease = first.begin()!;
      first.awaitWallet(lease, () => store);
      first.broadcast(lease, transaction, undefined, () => store);
      first.finish(lease);
      const reloaded = createDaoActionSession(context);
      reloaded.restore(() => store, target);
      expect(reloaded.getSnapshot().transaction).toMatchObject({
        hash,
        phase: "unknown",
      });
      expect(reloaded.begin()).toBeUndefined();
      const check = reloaded.begin(true)!;
      reloaded.updateTransaction(
        check,
        hash,
        { ...transaction, phase: "confirmed" },
        () => store,
      );
      reloaded.finish(check);
      expect(store.getItem(`artfi:dao-pending:${context}`)).toBeNull();
      expect(reloaded.begin()).toBeDefined();
    },
  );

  it("preserves a no-hash wallet request across reload instead of pretending it was cancelled", () => {
    const store = storage();
    const first = createDaoActionSession("no-hash");
    const lease = first.begin()!;
    first.awaitWallet(lease, () => store);
    const reloaded = createDaoActionSession("no-hash");
    reloaded.restore(() => store, target);
    expect(reloaded.getSnapshot()).toMatchObject({
      awaitingWallet: true,
      busy: false,
    });
    expect(reloaded.getSnapshot().recoveryNotice).toContain(
      "no known transaction hash",
    );
    expect(reloaded.begin()).toBeUndefined();
    expect(reloaded.begin(true)).toBeUndefined();
    expect(store.getItem("artfi:dao-pending:no-hash")).not.toContain(
      "signature",
    );
  });

  it("clears only a recognized wallet refusal and retains an uncertain network failure", () => {
    for (const rejected of [true, false]) {
      const store = storage();
      const context = `refusal-${rejected}`;
      const session = createDaoActionSession(context);
      const lease = session.begin()!;
      session.awaitWallet(lease, () => store);
      session.fail(
        lease,
        rejected ? "wallet declined" : "connection lost",
        rejected,
        () => store,
      );
      session.finish(lease);
      expect(session.getSnapshot().awaitingWallet).toBe(!rejected);
      expect(store.getItem(`artfi:dao-pending:${context}`) === null).toBe(
        rejected,
      );
      expect(session.begin() !== undefined).toBe(rejected);
    }
    expect(isDaoWalletRejection({ cause: { code: 4001 } })).toBe(true);
    expect(
      isDaoWalletRejection({ cause: { name: "UserRejectedRequestError" } }),
    ).toBe(true);
    expect(isDaoWalletRejection(new Error("network disconnected"))).toBe(false);
  });

  it("does not replace another saved request or clear it with an old operation", () => {
    const store = storage();
    const session = createDaoActionSession("record-owner");
    const lease = session.begin()!;
    session.awaitWallet(lease, () => store);
    session.broadcast(lease, transaction, undefined, () => store);
    const other = JSON.stringify({
      version: 1,
      requestId: "other-request",
      hash: replacement,
    });
    store.setItem("artfi:dao-pending:record-owner", other);
    expect(session.replaceHash(lease, hash, replacement, () => store)).toBe(
      false,
    );
    session.updateTransaction(
      lease,
      hash,
      { ...transaction, phase: "confirmed" },
      () => store,
    );
    session.finish(lease);
    expect(store.getItem("artfi:dao-pending:record-owner")).toBe(other);
    expect(session.begin()).toBeUndefined();
  });

  it("keeps malformed recovery blocked and does not start a write when saving the prompt marker fails", () => {
    const store = storage();
    store.setItem("artfi:dao-pending:malformed", "{");
    const corrupt = createDaoActionSession("malformed");
    corrupt.restore(() => store, target);
    expect(corrupt.begin()).toBeUndefined();
    const session = createDaoActionSession("storage-failure");
    const lease = session.begin()!;
    expect(() =>
      session.awaitWallet(lease, () => ({
        ...store,
        setItem() {
          throw new Error("quota");
        },
      })),
    ).toThrow("quota");
    expect(session.getSnapshot().awaitingWallet).toBe(false);
  });
});

describe("DAO terminal recovery notices", () => {
  it.each(["confirmed", "failed"] as const)(
    "regression terminal: a %s owned request retires its unresolved notice",
    (phase) => {
      const store = storage(),
        session = createDaoActionSession("terminal-" + phase),
        lease = session.begin()!;
      session.awaitWallet(lease, () => store);
      session.broadcast(lease, transaction, undefined, () => store);
      expect(session.getSnapshot().recoveryNotice).toContain("unresolved");
      session.updateTransaction(
        lease,
        hash,
        { ...transaction, phase },
        () => store,
      );
      expect(session.getSnapshot().transaction?.phase).toBe(phase);
      expect(session.getSnapshot().recoveryNotice).toBe("");
      expect(session.getSnapshot().awaitingWallet).toBe(false);
      session.finish(lease);
      expect(session.begin()).toBeDefined();
    },
  );
  it.each(["confirmed", "failed"] as const)(
    "a reloaded %s receipt clears its own notice only after removing the owned record",
    (phase) => {
      const store = storage(),
        context = "terminal-reload-" + phase,
        first = createDaoActionSession(context),
        lease = first.begin()!;
      first.awaitWallet(lease, () => store);
      first.broadcast(lease, transaction, undefined, () => store);
      first.finish(lease);
      const reloaded = createDaoActionSession(context);
      reloaded.restore(() => store, target);
      const check = reloaded.begin(true)!;
      reloaded.updateTransaction(
        check,
        hash,
        { ...transaction, phase },
        () => store,
      );
      expect(store.getItem("artfi:dao-pending:" + context)).toBeNull();
      expect(reloaded.getSnapshot().recoveryNotice).toBe("");
    },
  );
  it.each([true, false])(
    "retains the proposal package save outcome after confirmation: %s",
    (canSave) => {
      const memory = storage();
      const store = {
        ...memory,
        setItem(key: string, value: string) {
          if (!canSave && !key.startsWith("artfi:dao-pending:"))
            throw Error("TEST_ONLY quota");
          memory.setItem(key, value);
        },
      };
      const session = createDaoActionSession("terminal-package-" + canSave),
        lease = session.begin()!;
      session.awaitWallet(lease, () => store);
      session.broadcast(
        lease,
        { ...transaction, proposalCreation: true },
        proposal,
        () => store,
      );
      session.updateTransaction(
        lease,
        hash,
        { ...transaction, proposalCreation: true, phase: "confirmed" },
        () => store,
      );
      expect(session.getSnapshot().recoveryNotice).toContain(
        canSave
          ? "retains the submitted execution package"
          : "could not save its execution package",
      );
      expect(session.getSnapshot().awaitingWallet).toBe(false);
      expect(session.getSnapshot().submitted?.proposal).toEqual(proposal);
    },
  );
  it("never clears a blocking notice when removal of the owned record fails", () => {
    const memory = storage(),
      session = createDaoActionSession("terminal-remove-fails"),
      lease = session.begin()!;
    session.awaitWallet(lease, () => memory);
    session.broadcast(lease, transaction, undefined, () => memory);
    session.updateTransaction(
      lease,
      hash,
      { ...transaction, phase: "confirmed" },
      () => ({
        ...memory,
        removeItem() {
          throw Error("TEST_ONLY removal unavailable");
        },
      }),
    );
    expect(
      memory.getItem("artfi:dao-pending:terminal-remove-fails"),
    ).not.toBeNull();
    expect(session.getSnapshot().awaitingWallet).toBe(true);
    expect(session.getSnapshot().recoveryNotice).toContain(
      "could not be cleared",
    );
    expect(session.getSnapshot().recoveryNotice).not.toContain(
      "removal unavailable",
    );
    session.finish(lease);
    expect(session.begin()).toBeUndefined();
  });
  it("keeps UNKNOWN notice and the original request until reconciliation", () => {
    const store = storage(),
      session = createDaoActionSession("terminal-unknown"),
      lease = session.begin()!;
    session.awaitWallet(lease, () => store);
    session.broadcast(lease, transaction, undefined, () => store);
    const notice = session.getSnapshot().recoveryNotice;
    session.updateTransaction(
      lease,
      hash,
      { ...transaction, phase: "unknown" },
      () => store,
    );
    expect(session.getSnapshot().recoveryNotice).toBe(notice);
    expect(store.getItem("artfi:dao-pending:terminal-unknown")).not.toBeNull();
    session.finish(lease);
    expect(session.begin()).toBeUndefined();
  });
  it("does not let a stale lease erase the current unresolved notice", () => {
    const store = storage(),
      session = createDaoActionSession("terminal-stale"),
      lease = session.begin()!;
    session.awaitWallet(lease, () => store);
    session.broadcast(lease, transaction, undefined, () => store);
    session.finish(lease);
    const check = session.begin(true)!,
      notice = session.getSnapshot().recoveryNotice;
    expect(
      session.updateTransaction(
        lease,
        hash,
        { ...transaction, phase: "confirmed" },
        () => store,
      ),
    ).toBe(false);
    expect(session.getSnapshot().recoveryNotice).toBe(notice);
    expect(store.getItem("artfi:dao-pending:terminal-stale")).not.toBeNull();
    session.finish(check);
  });
});

describe("DAO public failure and recovery privacy", () => {
  const diagnostic =
    "TEST_ONLY untrusted provider or storage diagnostic: " + "x".repeat(12_000);
  const assertPrivate = (
    session: ReturnType<typeof createDaoActionSession>,
  ) => {
    const visible = JSON.stringify(session.getSnapshot());
    expect(visible).not.toContain(diagnostic);
    expect(visible).not.toContain("TEST_ONLY");
    expect(visible.length).toBeLessThan(2_000);
  };

  it.each(["error", "syntax", "object"] as const)(
    "bounds a %s recovery failure without unlocking an unknown wallet outcome",
    (kind) => {
      const session = createDaoActionSession("private-restore-" + kind);
      const cause =
        kind === "error"
          ? new Error(diagnostic)
          : kind === "syntax"
            ? new SyntaxError(diagnostic)
            : { message: diagnostic };
      session.restore(() => {
        throw cause;
      }, target);
      expect(session.getSnapshot().awaitingWallet).toBe(true);
      expect(session.getSnapshot().recoveryNotice).toContain(
        "recovery is unavailable",
      );
      expect(session.begin()).toBeUndefined();
      expect(session.begin(true)).toBeUndefined();
      assertPrivate(session);
    },
  );

  it("keeps the known hash when reading the saved proposal package fails", () => {
    const memory = storage();
    const context = "private-package-read";
    const first = createDaoActionSession(context);
    const lease = first.begin()!;
    first.awaitWallet(lease, () => memory);
    first.broadcast(lease, transaction, undefined, () => memory);
    first.finish(lease);
    const original = new Map(memory.values);
    const reloaded = createDaoActionSession(context);
    reloaded.restore(
      () => ({
        ...memory,
        getItem(key: string) {
          if (key === "artfi:dao-pending:" + context)
            return memory.getItem(key);
          throw new Error(diagnostic);
        },
      }),
      target,
    );
    expect(reloaded.getSnapshot().transaction).toMatchObject({
      hash,
      phase: "unknown",
    });
    expect(reloaded.begin()).toBeUndefined();
    expect(memory.values).toEqual(original);
    assertPrivate(reloaded);
    const check = reloaded.begin(true)!;
    expect(check).toBeDefined();
    reloaded.finish(check);
  });

  it.each(["confirmed", "failed"] as const)(
    "redacts a %s cleanup failure while preserving the request for reconciliation",
    (phase) => {
      const memory = storage();
      const context = "private-clear-" + phase;
      const session = createDaoActionSession(context);
      const lease = session.begin()!;
      session.awaitWallet(lease, () => memory);
      session.broadcast(lease, transaction, undefined, () => memory);
      const original = new Map(memory.values);
      session.updateTransaction(lease, hash, { ...transaction, phase }, () => ({
        ...memory,
        removeItem() {
          throw new Error(diagnostic);
        },
      }));
      expect(session.getSnapshot().transaction).toMatchObject({ hash, phase });
      expect(session.getSnapshot().awaitingWallet).toBe(true);
      expect(session.getSnapshot().recoveryNotice).toContain(
        "New writes remain blocked",
      );
      expect(memory.values).toEqual(original);
      assertPrivate(session);
      session.finish(lease);
      expect(session.begin()).toBeUndefined();

      // The live session keeps its original unresolved-wallet lease barrier.
      expect(session.begin(true)).toBeUndefined();

      // Reload the saved hash and reconcile it; never issue another wallet request.
      const reloaded = createDaoActionSession(context);
      reloaded.restore(() => memory, target);
      expect(reloaded.getSnapshot().transaction).toMatchObject({
        hash,
        phase: "unknown",
      });
      expect(memory.values).toEqual(original);
      expect(reloaded.begin()).toBeUndefined();
      const check = reloaded.begin(true)!;
      expect(check).toBeDefined();
      expect(
        reloaded.updateTransaction(
          check,
          hash,
          { ...transaction, phase },
          () => memory,
        ),
      ).toBe(true);
      reloaded.finish(check);
      expect(memory.getItem("artfi:dao-pending:" + context)).toBeNull();
      expect(reloaded.getSnapshot().awaitingWallet).toBe(false);
      assertPrivate(reloaded);
      expect(reloaded.begin()).toBeDefined();
    },
  );

  it.each([true, false])(
    "redacts a wallet failure while retaining the recognized-refusal distinction: %s",
    (rejected) => {
      const memory = storage();
      const context = "private-wallet-" + rejected;
      const session = createDaoActionSession(context);
      const lease = session.begin()!;
      session.awaitWallet(lease, () => memory);
      session.fail(lease, diagnostic, rejected, () => memory);
      session.finish(lease);
      expect(session.getSnapshot().actionError).toContain("Review its inputs");
      expect(session.getSnapshot().awaitingWallet).toBe(!rejected);
      expect(memory.getItem("artfi:dao-pending:" + context) === null).toBe(
        rejected,
      );
      assertPrivate(session);
      expect(session.begin() !== undefined).toBe(rejected);
    },
  );

  it("bounds a pre-wallet persistence failure without inventing a submitted request", () => {
    const memory = storage();
    const context = "private-prompt-save";
    const session = createDaoActionSession(context);
    const lease = session.begin()!;
    let failure: unknown;
    try {
      session.awaitWallet(lease, () => ({
        ...memory,
        setItem() {
          throw new Error(diagnostic);
        },
      }));
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(Error);
    session.fail(lease, (failure as Error).message, false, () => memory);
    session.finish(lease);
    expect(memory.values.size).toBe(0);
    expect(session.getSnapshot().transaction).toBeUndefined();
    expect(session.getSnapshot().awaitingWallet).toBe(false);
    assertPrivate(session);
    expect(session.begin()).toBeDefined();
  });

  it.each([true, false])(
    "never clears a known pending transaction after a later error marked refused=%s",
    (rejected) => {
      const memory = storage();
      const session = createDaoActionSession("private-known-hash-" + rejected);
      const lease = session.begin()!;
      session.awaitWallet(lease, () => memory);
      session.broadcast(lease, transaction, undefined, () => memory);
      const original = new Map(memory.values);
      session.fail(lease, diagnostic, rejected, () => memory);
      session.finish(lease);
      expect(session.getSnapshot().transaction).toMatchObject({
        hash,
        phase: "pending",
      });
      expect(memory.values).toEqual(original);
      expect(session.begin()).toBeUndefined();
      assertPrivate(session);
    },
  );
});
