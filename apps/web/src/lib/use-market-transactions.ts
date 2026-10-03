"use client";

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { Hash, PublicClient } from "viem";
import { currentOperation } from "./current-operation";
import {
  confirmMarketReceipt,
  confirmMarketWrite,
  settleConfirmedSale,
  MarketReceiptFinalError,
  marketWriteJournal,
  type MarketWriteKind,
  type PendingMarketWrite,
} from "./market-transaction";

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
  options: {
    operationContext?: string;
    beforeWrite?: () => Promise<void>;
  } = {},
) {
  const { operationContext = context, beforeWrite } = options;
  const journal = useMemo(() => {
    let storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> =
      unavailableStorage;
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
      return journal.pending();
    } catch {
      return {
        kind: "unknown",
        hash: "The saved transaction record is unreadable.",
        intentHash: undefined,
      };
    }
  }, [saved, journal]);
  const generation = useRef(currentOperation());
  useLayoutEffect(() => {
    const current = currentOperation();
    generation.current = current;
    return () => current.retire();
  }, [context, operationContext]);
  const begin = useCallback(
    (intentHash?: Hash) => {
      if (!client) throw new Error("The chain client is unavailable.");
      journal.assertReady();
      const probe = `artfi:pending-storage-check:${context}`;
      window.sessionStorage.setItem(probe, "ok");
      window.sessionStorage.removeItem(probe);
      const current = generation.current;
      const assertCurrent = current.assertCurrent;
      assertCurrent();
      const guarded = async <T>(submit: () => Promise<T>) => {
        assertCurrent();
        await beforeWrite?.();
        assertCurrent();
        return submit();
      };
      // Wallet signatures also belong to this session and these original terms.
      const authorize = async <T>(submit: () => Promise<T>) => {
        journal.lockWalletRequest();
        try {
          const value = await guarded(submit);
          assertCurrent();
          return value;
        } finally {
          journal.unlockWalletRequest();
        }
      };
      const write = async (
        kind: MarketWriteKind,
        submit: () => Promise<Hash>,
      ) => {
        assertCurrent();
        journal.lockWalletRequest();
        let recorded: PendingMarketWrite | undefined;
        try {
          const receipt = await confirmMarketWrite(
            client,
            () => guarded(submit),
            (hash) => {
              recorded = { hash, kind, intentHash };
              journal.record(recorded);
              if (current.isCurrent()) onHash(hash);
            },
          );
          if (recorded) journal.clear(recorded);
          assertCurrent();
          return receipt;
        } catch (error) {
          if (error instanceof MarketReceiptFinalError && recorded)
            journal.clear(recorded);
          throw error;
        } finally {
          journal.unlockWalletRequest();
        }
      };
      const settle = async (settlement: {
        approvePayment: () => Promise<Hash>;
        settle: () => Promise<Hash>;
        onStage: (stage: "approving" | "filling") => void;
      }) => {
        assertCurrent();
        let kind: MarketWriteKind = "approval";
        let recorded: PendingMarketWrite | undefined;
        journal.lockWalletRequest();
        try {
          const receipt = await settleConfirmedSale({
            ...settlement,
            client,
            approvePayment: () => guarded(settlement.approvePayment),
            settle: () => guarded(settlement.settle),
            isCurrent: current.isCurrent,
            onStage(stage) {
              if (stage === "filling" && recorded) journal.clear(recorded);
              kind = stage === "approving" ? "approval" : "fill";
              if (current.isCurrent()) settlement.onStage(stage);
            },
            onHash(hash) {
              recorded = { hash, kind, intentHash };
              journal.record(recorded);
              if (current.isCurrent()) onHash(hash);
            },
          });
          if (recorded) journal.clear(recorded);
          assertCurrent();
          return receipt;
        } catch (error) {
          if (error instanceof MarketReceiptFinalError && recorded)
            journal.clear(recorded);
          throw error;
        } finally {
          journal.unlockWalletRequest();
        }
      };
      return {
        write,
        settle,
        authorize,
        assertCurrent,
        isCurrent: current.isCurrent,
      };
    },
    [client, context, journal, onHash, beforeWrite],
  );
  const reconcile = useCallback(async () => {
    if (!client) throw new Error("The chain client is unavailable.");
    const current = generation.current;
    let outstanding = journal.pending();
    if (!outstanding) return undefined;
    try {
      await confirmMarketReceipt(client, outstanding.hash, (hash) => {
        const replacement = { ...outstanding!, hash };
        // Another mounted screen may already have reconciled this receipt and
        // submitted a new transaction. An older callback cannot take its record.
        if (journal.compareAndReplace(outstanding!, replacement)) {
          outstanding = replacement;
          if (current.isCurrent()) onHash(hash);
        }
      });
      journal.clear(outstanding);
      return outstanding;
    } catch (error) {
      if (error instanceof MarketReceiptFinalError) journal.clear(outstanding);
      throw error;
    }
  }, [client, journal, onHash]);
  const captureReadContext = useCallback(
    () => generation.current.isCurrent,
    [],
  );
  return { pending, begin, reconcile, captureReadContext };
}
