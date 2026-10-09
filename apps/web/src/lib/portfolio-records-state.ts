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
    const response = await request(
      `/api/portfolio/${encodeURIComponent(address)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal,
      },
    );
    if (!response.ok)
      throw new Error(`Portfolio API returned ${response.status}.`);
    const value = (await response.json()) as Portfolio;
    if (signal.aborted) return;
    if (
      typeof value?.address !== "string" ||
      value.address.toLowerCase() !== address.toLowerCase() ||
      value.chainId !== 560048
    ) {
      throw new Error(
        "Portfolio response did not match the connected Hoodi address.",
      );
    }
    if (
      !Array.isArray(value.positions) ||
      !Array.isArray(value.transactions) ||
      !Array.isArray(value.notifications) ||
      (value.performance !== undefined && !validPerformance(value.performance))
    ) {
      throw new Error(
        "Portfolio records are unavailable: the API response was incomplete.",
      );
    }
    update({ loading: false, portfolio: value });
  } catch (reason) {
    if (signal.aborted) return;
    update({
      loading: false,
      error:
        reason instanceof Error
          ? reason.message
          : "Portfolio records are unavailable.",
    });
  }
}

function validPerformance(value: PortfolioPerformance) {
  const integer = (amount: unknown, signed = false) =>
    amount === null ||
    (typeof amount === "string" &&
      (signed ? /^-?(0|[1-9][0-9]*)$/ : /^(0|[1-9][0-9]*)$/).test(amount));
  return (
    value !== null &&
    value.method === "fifo" &&
    value.scope === "confirmed_indexed_fraction_trades" &&
    ["unknown", "known_for_indexed_history", "no_indexed_history"].includes(
      value.status,
    ) &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === "string") &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        typeof item.assetToken === "string" &&
        (item.paymentToken === null || typeof item.paymentToken === "string") &&
        ["known", "unknown"].includes(item.status) &&
        integer(item.confirmedQuantity, true) &&
        integer(item.costBasis) &&
        integer(item.realizedPnl, true) &&
        (item.status !== "known" ||
          (item.paymentToken !== null &&
            item.costBasis !== null &&
            item.realizedPnl !== null)) &&
        Array.isArray(item.reasons) &&
        item.reasons.every((reason) => typeof reason === "string"),
    )
  );
}
