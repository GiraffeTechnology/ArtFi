import "server-only";
import {
  createNftTaskJournal,
  type NftTaskJournalConfig,
} from "./nft/task-journal";
import {
  createWholeReceiptPreparedJournal,
  type ReceiptJournalOperation,
} from "./whole-receipt-prepared-journal";

/** Installation composition of the existing preparation context and fixed
 * authenticated native journal. The supplied capability callback reuses the
 * held preparation gate; it must not acquire a second grant-store lock.
 * This port prepares or reads unsigned durable state and never sends a chain
 * transaction, constructs credentials, or supplies a transport fallback. */
export function createWholeReceiptNativeJournal(
  options: Omit<
    Parameters<typeof createWholeReceiptPreparedJournal>[0],
    "journal"
  > & {
    journalConfig: NftTaskJournalConfig<ReceiptJournalOperation["plan"]>;
  },
) {
  return createWholeReceiptPreparedJournal({
    runtime: options.runtime,
    claimed: options.claimed,
    now: options.now,
    journal: createNftTaskJournal<ReceiptJournalOperation["plan"]>(
      options.journalConfig,
    ),
  });
}
