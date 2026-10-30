/**
 * The isolated-world relay between the page provider and the service worker.
 *
 * `provider.ts` runs in the page's world, where `chrome.runtime` does not exist; the service
 * worker holds the grants and the vault. This file is the only thing that talks to both, and it
 * is deliberately the dullest file in the package: it copies a method name and its params across,
 * and copies an answer back.
 *
 * What it must never do is tell the service worker which origin is asking. The browser reports
 * that as `sender.origin`, and a page that could supply it instead would be able to borrow
 * another site's grant.
 *
 * No imports: a script registered through `chrome.scripting` is a classic script, not a module.
 * The channel names are the wire protocol shared with `provider.ts`.
 */
(() => {
  // Chrome keeps this marker in the extension's isolated world. Re-enabling a site
  // must not make one page request dispatch twice to the service worker.
  const installationKey = Symbol.for("artfi.wallet.isolated-bridge.v1");
  if ((window as unknown as Record<symbol, unknown>)[installationKey]) return;
  Object.defineProperty(window, installationKey, {
    value: true,
    configurable: false,
    writable: false,
  });
  const CHANNEL_REQUEST = "artfi-wallet:request";
  const CHANNEL_RESPONSE = "artfi-wallet:response";
  const CHANNEL_ACCOUNTS = "artfi-wallet:accounts-changed";

  let statePort: ChromeRuntimePort | null = null;
  let reconnectTimer: number | undefined;
  let active = true;
  let reconnectDelay = 250;

  function publishAccounts(accounts: unknown): void {
    if (
      !Array.isArray(accounts) ||
      !accounts.every(
        (account: unknown) =>
          typeof account === "string" && /^0x[0-9a-fA-F]{40}$/.test(account),
      )
    )
      return;
    window.postMessage(
      { channel: CHANNEL_ACCOUNTS, accounts },
      window.location.origin,
    );
  }

  function reconnect(): void {
    if (!active || reconnectTimer !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connectState();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }

  function connectState(): void {
    if (!active || statePort) return;
    try {
      const port = chrome.runtime.connect({ name: "artfi-provider-state" });
      statePort = port;
      port.onMessage.addListener((message: unknown) => {
        if (statePort !== port || !active) return;
        const update = message as { type?: unknown; accounts?: unknown } | null;
        if (update?.type !== "provider.accountsChanged") return;
        publishAccounts(update.accounts);
        reconnectDelay = 250;
      });
      port.onDisconnect.addListener(() => {
        if (statePort !== port) return;
        statePort = null;
        // A restarted worker has no unlocked vault payload until it is unlocked again.
        publishAccounts([]);
        reconnect();
      });
    } catch {
      statePort = null;
      publishAccounts([]);
      reconnect();
    }
  }

  window.addEventListener("pagehide", () => {
    active = false;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    const port = statePort;
    statePort = null;
    port?.disconnect();
  });
  window.addEventListener("pageshow", () => {
    active = true;
    connectState();
  });
  connectState();

  function respond(id: string, payload: Record<string, unknown>): void {
    window.postMessage(
      { channel: CHANNEL_RESPONSE, id, ...payload },
      window.location.origin,
    );
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data as {
      channel?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    } | null;
    if (!data || data.channel !== CHANNEL_REQUEST) return;
    if (typeof data.id !== "string" || typeof data.method !== "string") return;

    const id = data.id;
    void chrome.runtime
      .sendMessage({
        type: "provider.request",
        method: data.method,
        params: data.params,
      })
      .then((response: unknown) => {
        const answer = response as
          | {
              ok?: unknown;
              result?: unknown;
              error?: unknown;
              code?: unknown;
            }
          | undefined;
        if (answer && answer.ok === true) {
          respond(id, { result: answer.result });
          return;
        }
        respond(id, {
          error: {
            message:
              answer && typeof answer.error === "string"
                ? answer.error
                : "ArtFi Wallet request failed",
            code:
              answer && typeof answer.code === "number" ? answer.code : 4200,
          },
        });
      })
      .catch((error: unknown) => {
        // A disconnected service worker is a disconnected wallet (EIP-1193 4900), not a
        // rejected request: the page should retry rather than tell the person they declined.
        respond(id, {
          error: {
            message:
              error instanceof Error
                ? error.message
                : "ArtFi Wallet is unavailable",
            code: 4900,
          },
        });
      });
  });
})();
