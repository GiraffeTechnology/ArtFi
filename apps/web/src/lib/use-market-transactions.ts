"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Hash, PublicClient } from "viem";
import {
  confirmMarketReceipt,
  confirmMarketWrite,
  settleConfirmedSale,
  MarketReceiptFinalError,
  marketWriteJournal,
  type MarketWriteKind,
  type PendingMarketWrite,
} from "./market-transaction";

// Server snapshots never access browser storage. A browser unable to persist an unresolved
// broadcast must not start a write that a refresh could accidentally submit twice.
const unavailableStorage = {
  getItem: () => null,
  setItem: () => {
    throw new Error(
      "Browser session storage is unavailable. Enable it before submitting transactions.",
    );
  },
  removeItem: () => {},
};

export function useMarketTransactions(
  client: Pick<PublicClient, "waitForTransactionReceipt"> | undefined,
  context: string,
  onHash: (hash: Hash) => void,
) {
  const journal = useMemo(() => {
    let storage = unavailableStorage as Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >;
    try {
      if (typeof window !== "undefined") storage = window.sessionStorage;
    } catch {
      /* Writes remain unavailable. */
    }
    return marketWriteJournal(storage, `artfi:pending:${context}`);
  }, [context]);
  const saved = useSyncExternalStore(
    journal.subscribe,
    journal.getSnapshot,
    () => null,
  );
  const pending = useMemo(() => {
    if (!saved) return undefined;
    try {
      return JSON.parse(saved) as PendingMarketWrite;
    } catch {
      return {
        kind: "unknown",
        hash: "The saved transaction record is unreadable.",
      };
    }
  }, [saved]);
  const generation = useRef({ context, active: true });
  useLayoutEffect(() => {
    const current = { context, active: true };
    generation.current = current;
    return () => {
      current.active = false;
    };
  }, [context]);
  const begin = useCallback(() => {
    if (!client) throw new Error("The chain client is unavailable.");
    journal.assertReady();
    // Verify storage before asking the wallet. Only public transaction hashes are retained.
    const probe = `artfi:pending-storage-check:${context}`;
    window.sessionStorage.setItem(probe, "ok");
    window.sessionStorage.removeItem(probe);
    const current = generation.current;
    const assertCurrent = () => {
      if (
        !current.active ||
        current !== generation.current ||
        current.context !== context
      )
        throw new Error(
          "The screen, wallet or asset changed. No further wallet request was made.",
        );
    };
    assertCurrent();
    const write = async (
      kind: MarketWriteKind,
      submit: () => Promise<Hash>,
    ) => {
      assertCurrent();
      journal.lockWalletRequest();
      try {
        const receipt = await confirmMarketWrite(client, submit, (hash) => {
          journal.record({ hash, kind });
          onHash(hash);
        });
        journal.clear();
        return receipt;
      } catch (error) {
        if (error instanceof MarketReceiptFinalError) journal.clear();
        throw error;
      } finally {
        journal.unlockWalletRequest();
      }
    };
    const settle = async (options: {
      approvePayment: () => Promise<Hash>;
      settle: () => Promise<Hash>;
      onStage: (stage: "approving" | "filling") => void;
    }) => {
      let kind: MarketWriteKind = "approval";
      journal.lockWalletRequest();
      try {
        const receipt = await settleConfirmedSale({
          ...options,
          client,
          isCurrent: () =>
            current.active &&
            current === generation.current &&
            current.context === context,
          onStage(stage) {
            if (stage === "filling") journal.clear();
            kind = stage === "approving" ? "approval" : "fill";
            options.onStage(stage);
          },
          onHash(hash) {
            journal.record({ hash, kind });
            onHash(hash);
          },
        });
        journal.clear();
        return receipt;
      } catch (error) {
        if (error instanceof MarketReceiptFinalError) journal.clear();
        throw error;
      } finally {
        journal.unlockWalletRequest();
      }
    };
    return { write, settle };
  }, [client, context, journal, onHash]);
  const reconcile = useCallback(async () => {
    if (!client) throw new Error("The chain client is unavailable.");
    const outstanding = journal.pending();
    if (!outstanding) return undefined;
    try {
      await confirmMarketReceipt(client, outstanding.hash, (hash) => {
        journal.record({ ...outstanding, hash });
        onHash(hash);
      });
      journal.clear();
      return outstanding.kind;
    } catch (error) {
      if (error instanceof MarketReceiptFinalError) journal.clear();
      throw error;
    }
  }, [client, journal, onHash]);
  return { pending, begin, reconcile };
}
