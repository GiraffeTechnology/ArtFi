import {
  PortfolioRequestError,
  requestPortfolioRecords,
} from "./portfolio-request";
import {
  parsePortfolioRecords,
  PortfolioRecordsError,
} from "./portfolio-records-contract";

export type PortfolioEntry = {
  id: string;
  transactionHash: string;
  logIndex: number;
  contractAddress: string;
  eventName: string;
  blockNumber: number;
  status: "pending" | "confirmed" | "removed";
  observedAt: string;
};

export type PortfolioPerformance = {
  status: "no_indexed_history" | "known_for_indexed_history" | "unknown";
  method: "fifo";
  scope: "confirmed_indexed_fraction_trades";
  items: Array<{
    assetToken: string;
    paymentToken: string | null;
    confirmedQuantity: string | null;
    costBasis: string | null;
    realizedPnl: string | null;
    status: "known" | "unknown";
    buyCount: number;
    sellCount: number;
    reasons: string[];
  }>;
  unmappedTradeCount: number;
  pendingEventCount: number;
  reasons: string[];
};

export type Portfolio = {
  address: string;
  chainId: number;
  network: string;
  positions: Array<{
    assetToken: string;
    symbol: string;
    balance: string;
    updatedAt: string;
  }>;
  transactions: PortfolioEntry[];
  offers: unknown[];
  notifications: Array<PortfolioEntry & { message: string }>;
  // Older deployments may have no performance projection. Absence is unknown,
  // never a zero P&L. The backend always supplies this in the current contract.
  performance?: PortfolioPerformance;
};

export type PortfolioState = {
  loading: boolean;
  portfolio?: Portfolio;
  error?: string;
};

/** A cancelled wallet request cannot publish a late response, including delayed JSON parsing. */
export async function loadPortfolioRecords({
  address,
  signal,
  update,
  request = fetch,
}: {
  address: string;
  signal: AbortSignal;
  update: (state: PortfolioState) => void;
  request?: typeof fetch;
}) {
  if (signal.aborted) return;
  update({ loading: true });
  try {
    const value = parsePortfolioRecords(
      await requestPortfolioRecords(request, address, signal),
      address,
    );
    if (signal.aborted) return;
    update({ loading: false, portfolio: value });
  } catch (reason) {
    if (signal.aborted) return;
    update({
      loading: false,
      error:
        reason instanceof PortfolioRecordsError ||
        reason instanceof PortfolioRequestError
          ? reason.message
          : "Portfolio records are unavailable.",
    });
  }
}
