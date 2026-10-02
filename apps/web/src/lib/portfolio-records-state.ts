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
  transactions: Array<{
    transactionHash: string;
    eventName: string;
    blockNumber: number;
    status: string;
    observedAt: string;
  }>;
  offers: unknown[];
  notifications: unknown[];
};

export type PortfolioState = {
  loading: boolean;
  portfolio?: Portfolio;
  error?: string;
};

/** A cancelled wallet request cannot publish a late response, including delayed JSON parsing. */
export async function loadPortfolioRecords({
  address,
  apiURL,
  signal,
  update,
  request = fetch,
}: {
  address: string;
  apiURL: string;
  signal: AbortSignal;
  update: (state: PortfolioState) => void;
  request?: typeof fetch;
}) {
  if (signal.aborted) return;
  update({ loading: true });
  try {
    const response = await request(
      `${apiURL}/v1/portfolio/${encodeURIComponent(address)}`,
      { cache: "no-store", signal },
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
    if (!Array.isArray(value.positions) || !Array.isArray(value.transactions)) {
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
