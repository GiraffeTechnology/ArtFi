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
const receipt = (
  status: "success" | "reverted" = "success",
  transactionHash = hash,
) => ({ status, transactionHash }) as TransactionReceipt;
const client = (wait: ReturnType<typeof vi.fn>) =>
  ({ waitForTransactionReceipt: wait }) as unknown as Pick<
    PublicClient,
    "waitForTransactionReceipt"
  >;
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
      client: client(vi.fn().mockRejectedValue(new Error("timeout"))),
      transaction,
      isCurrent: () => true,
      update,
    });
    expect(first.phase).toBe("unknown");
    const retried = await checkDaoTransaction({
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
