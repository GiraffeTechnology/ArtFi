import {
  parseXionganWalletURL,
  type XionganWalletConfig,
} from "./xiongan-wallet";

export type XionganWalletState =
  | XionganWalletConfig
  | {
      ok: false;
      code: "LOADING" | "UNAVAILABLE";
    };

export const walletConfigMessages = {
  LOADING: "Loading Xiongan Wallet configuration.",
  NOT_CONFIGURED:
    "Xiongan Wallet unavailable: deployment URL is not configured.",
  INVALID_CONFIG: "Xiongan Wallet unavailable: deployment URL is invalid.",
  UNAVAILABLE:
    "Xiongan Wallet configuration is unavailable. Retry to check again.",
};

export async function fetchXionganWalletConfig(
  signal: AbortSignal,
): Promise<XionganWalletConfig> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetch("/api/wallet-config", {
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Wallet configuration unavailable");
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "ok" in body) {
      if (body.ok === true && "url" in body) {
        const config = parseXionganWalletURL(body.url);
        if (config.ok) return config;
      }
      if (
        body.ok === false &&
        "code" in body &&
        (body.code === "NOT_CONFIGURED" || body.code === "INVALID_CONFIG")
      )
        return { ok: false, code: body.code };
    }
    throw new Error("Wallet configuration unavailable");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export function walletConfigView(query: {
  fetchStatus: "fetching" | "paused" | "idle";
  isPending: boolean;
  isError: boolean;
  data?: XionganWalletConfig;
}): XionganWalletState {
  if (query.fetchStatus === "paused") return { ok: false, code: "UNAVAILABLE" };
  // Never leave an old destination clickable while re-reading deployment config.
  if (query.fetchStatus === "fetching" || query.isPending)
    return { ok: false, code: "LOADING" };
  if (query.isError) return { ok: false, code: "UNAVAILABLE" };
  return query.data ?? { ok: false, code: "UNAVAILABLE" };
}
