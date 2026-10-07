import type { Hash } from "viem";

type Store = Pick<Storage, "getItem" | "setItem">;
export type SetupRecord<T> = {
  id: string;
  data: T;
  pending?: { id: string; step: string; hash?: Hash };
};
type Snapshot<T> = {
  record?: SetupRecord<T>;
  busy: boolean;
  blocked: boolean;
  error: string;
};
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const uncertain =
  "A wallet request has no known transaction hash. Check the wallet activity. Another write remains blocked; leaving or reloading does not cancel it.";

/** Only public reviewed bindings and transaction identity belong here, never files or signatures. */
export function createSetupRecoverySession<T>(
  context: string,
  validate: (data: unknown) => data is T,
) {
  const empty: Snapshot<T> = { busy: false, blocked: false, error: "" };
  let snapshot = empty;
  let restored = false;
  let storage: (() => Store) | undefined;
  let serialized: string | null = null;
  let operation: number | undefined;
  let generation = 0;
  let blocked = false;
  const listeners = new Set<() => void>();
  const key = `artfi:setup:${context}`;
  const publish = (next: Partial<Snapshot<T>>) => {
    snapshot = { ...snapshot, ...next, blocked };
    listeners.forEach((listener) => listener());
  };
  const current = (lease: number) => lease === operation;
  const assertCurrent = (lease: number) => {
    if (!current(lease))
      throw new Error("This setup operation is no longer active.");
  };
  const persist = (record: SetupRecord<T>) => {
    if (!storage) throw new Error("Browser setup recovery is not ready.");
    const target = storage();
    if (target.getItem(key) !== serialized) {
      blocked = true;
      throw new Error(
        "The saved setup changed or disappeared. New writes remain blocked until its original transaction is checked.",
      );
    }
    const next = JSON.stringify({ version: 1, ...record });
    if (next.length > 32_000)
      throw new Error("The public setup record is too large.");
    target.setItem(key, next);
    serialized = next;
    blocked = false;
    publish({ record });
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => empty,
    restore(source: () => Store) {
      if (restored) return;
      restored = true;
      storage = source;
      try {
        serialized = source().getItem(key);
        if (!serialized) return;
        if (serialized.length > 32_000) throw new Error();
        const record = JSON.parse(serialized);
        if (
          record.version !== 1 ||
          typeof record.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,64}$/.test(record.id) ||
          !validate(record.data)
        )
          throw new Error();
        const p = record.pending;
        if (
          p !== undefined &&
          (!p ||
            typeof p.id !== "string" ||
            !/^[a-zA-Z0-9-]{1,64}$/.test(p.id) ||
            typeof p.step !== "string" ||
            !/^[a-z-]{1,40}$/.test(p.step) ||
            (p.hash !== undefined && !hashPattern.test(p.hash)))
        )
          throw new Error();
        publish({
          record: { id: record.id, data: record.data, pending: p },
          error: p && !p.hash ? uncertain : "",
        });
      } catch {
        blocked = true;
        publish({
          error:
            "Browser setup recovery could not be read. Check the original wallet activity before continuing; new writes remain blocked.",
        });
      }
    },
    begin(checking = false) {
      if (
        !restored ||
        (blocked && !checking) ||
        operation !== undefined ||
        (snapshot.record?.pending && !checking)
      )
        return;
      operation = ++generation;
      publish({ busy: true, error: "" });
      return operation;
    },
    save(lease: number, data: T) {
      assertCurrent(lease);
      if (!validate(data))
        throw new Error(
          "The setup record does not match its reviewed bindings.",
        );
      persist({
        id: snapshot.record?.id ?? crypto.randomUUID(),
        data,
        pending: snapshot.record?.pending,
      });
    },
    awaitWallet(lease: number, step: string) {
      assertCurrent(lease);
      const record = snapshot.record;
      if (!record || record.pending || blocked)
        throw new Error(
          "Resolve the original setup transaction before another wallet request.",
        );
      persist({ ...record, pending: { id: crypto.randomUUID(), step } });
    },
    broadcast(lease: number, hash: Hash) {
      assertCurrent(lease);
      const record = snapshot.record;
      if (!record?.pending || !hashPattern.test(hash))
        throw new Error("The wallet result has no matching setup request.");
      const next = { ...record, pending: { ...record.pending, hash } };
      try {
        persist(next);
      } catch {
        blocked = true;
        // Preserve the late public result even if the original view is gone or disk failed.
        publish({
          record: next,
          error:
            "The transaction hash is retained in this tab but could not be saved. Keep this tab open and check its receipt; new writes remain blocked.",
        });
      }
    },
    repriced(lease: number, hash: Hash) {
      this.broadcast(lease, hash);
    },
    resolved(lease: number, data: T) {
      assertCurrent(lease);
      const record = snapshot.record;
      if (!record || !validate(data))
        throw new Error("The resolved setup record is invalid.");
      persist({ id: record.id, data });
    },
    rejected(lease: number) {
      assertCurrent(lease);
      const record = snapshot.record;
      if (record?.pending && !record.pending.hash) {
        try {
          persist({ id: record.id, data: record.data });
        } catch {
          publish({
            error:
              "The declined wallet request could not be cleared from recovery storage. New writes remain blocked.",
          });
        }
      }
    },
    fail(lease: number, error: unknown) {
      if (!current(lease)) return;
      const reason =
        error instanceof Error
          ? error.message
          : "Setup could not be completed.";
      publish({
        error:
          snapshot.record?.pending && !snapshot.record.pending.hash
            ? `${reason} ${uncertain}`
            : reason,
      });
    },
    finish(lease: number) {
      if (!current(lease)) return;
      operation = undefined;
      publish({ busy: false });
    },
  };
}

const sessions = new Map<string, unknown>();
export function setupRecoverySession<T>(
  context: string,
  validate: (data: unknown) => data is T,
) {
  let session = sessions.get(context) as
    ReturnType<typeof createSetupRecoverySession<T>> | undefined;
  if (!session) {
    session = createSetupRecoverySession(context, validate);
    sessions.set(context, session);
  }
  return session;
}

/** Read-only access to live public recovery state; it never creates or restores another wallet session. */
export function setupRecoverySnapshot<T>(context: string) {
  return (
    sessions.get(context) as
      ReturnType<typeof createSetupRecoverySession<T>> | undefined
  )?.getSnapshot();
}
