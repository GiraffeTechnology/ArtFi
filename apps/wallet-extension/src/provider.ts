/**
 * The EIP-6963 provider, running in the page's own world.
 *
 * ArtFi's web app registers exactly one connector, RainbowKit's `injectedWallet`, and that
 * connector is filtered out of the chooser unless a wallet announces itself over EIP-6963. This
 * file is that announcement, and the EIP-1193 surface behind it.
 *
 * It deliberately does not touch `window.ethereum`. Claiming that property would fight whatever
 * other wallet the person already installed, and EIP-6963 exists precisely so several wallets can
 * coexist. A page that only reads `window.ethereum` will not see this wallet; ArtFi reads the
 * announcement, which is the supported path.
 *
 * No imports: a script registered through `chrome.scripting` is a classic script, not a module.
 * The two channel names below are the whole wire protocol and are repeated in `bridge.ts`.
 */
(() => {
  // A renewed site grant can inject into a document that already has this provider.
  // Reannounce the same identity instead of registering another provider/listener set.
  const installationKey = Symbol.for("artfi.wallet.page-provider.v1");
  const installed = (
    window as unknown as Record<symbol, { announce: () => void } | undefined>
  )[installationKey];
  if (installed) {
    installed.announce();
    return;
  }
  const CHANNEL_REQUEST = "artfi-wallet:request";
  const CHANNEL_RESPONSE = "artfi-wallet:response";
  const CHANNEL_ACCOUNTS = "artfi-wallet:accounts-changed";
  const REQUEST_TIMEOUT_MS = 60_000;

  interface RequestArguments {
    method: string;
    params?: unknown;
  }

  interface ProviderRpcError extends Error {
    code: number;
  }

  type Listener = (...args: unknown[]) => void;

  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  const listeners = new Map<string, Set<Listener>>();
  let visibleAccounts: string[] | undefined;

  window.addEventListener("message", (event: MessageEvent) => {
    // Only this page, only this window: a message from a frame or another origin is not an
    // answer from the extension, whatever it claims to be.
    if (event.source !== window || event.origin !== window.location.origin) {
      return;
    }
    const data = event.data as {
      channel?: unknown;
      id?: unknown;
      result?: unknown;
      accounts?: unknown;
      error?: { message?: unknown; code?: unknown };
    } | null;
    if (!data) return;
    if (data.channel === CHANNEL_ACCOUNTS) {
      if (
        !Array.isArray(data.accounts) ||
        !data.accounts.every(
          (account: unknown) =>
            typeof account === "string" && /^0x[0-9a-fA-F]{40}$/.test(account),
        )
      )
        return;
      const accounts = [...data.accounts] as string[];
      if (
        visibleAccounts &&
        accounts.length === visibleAccounts.length &&
        accounts.every(
          (account, index) =>
            account.toLowerCase() === visibleAccounts![index]!.toLowerCase(),
        )
      )
        return;
      visibleAccounts = accounts;
      for (const listener of [...(listeners.get("accountsChanged") ?? [])]) {
        try {
          listener([...accounts]);
        } catch {
          // One consumer must not prevent others from observing permission loss.
        }
      }
      return;
    }
    if (data.channel !== CHANNEL_RESPONSE) return;
    if (typeof data.id !== "string") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) {
      const error = new Error(
        typeof data.error.message === "string"
          ? data.error.message
          : "ArtFi Wallet request failed",
      ) as ProviderRpcError;
      error.code = typeof data.error.code === "number" ? data.error.code : 4200;
      entry.reject(error);
      return;
    }
    entry.resolve(data.result);
  });

  function request(args: RequestArguments): Promise<unknown> {
    if (!args || typeof args.method !== "string") {
      const error = new Error("a request needs a method") as ProviderRpcError;
      error.code = -32602;
      return Promise.reject(error);
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      window.setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        const error = new Error(
          "ArtFi Wallet did not answer in time",
        ) as ProviderRpcError;
        error.code = 4900;
        reject(error);
      }, REQUEST_TIMEOUT_MS);
      window.postMessage(
        {
          channel: CHANNEL_REQUEST,
          id,
          method: args.method,
          params: args.params ?? [],
        },
        window.location.origin,
      );
    });
  }

  function on(event: string, listener: Listener): typeof provider {
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(event, set);
    return provider;
  }

  function removeListener(event: string, listener: Listener): typeof provider {
    listeners.get(event)?.delete(listener);
    return provider;
  }

  const provider = {
    isArtFiWallet: true as const,
    request,
    on,
    addListener: on,
    removeListener,
    off: removeListener,
    removeAllListeners(event?: string) {
      if (event === undefined) listeners.clear();
      else listeners.delete(event);
      return provider;
    },
  };

  // A 1-colour mark keeps the announcement self-contained; EIP-6963 requires a data URI.
  const icon =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
        '<rect width="96" height="96" rx="20" fill="#11100e"/>' +
        '<path d="M26 68 48 28l22 40H58l-10-19-10 19z" fill="#d9ff5a"/></svg>',
    );

  const detail = Object.freeze({
    info: Object.freeze({
      uuid: crypto.randomUUID(),
      name: "ArtFi Wallet Alpha",
      icon,
      rdns: "com.artcch.artfi",
    }),
    provider,
  });

  function announce(): void {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", { detail }),
    );
  }

  // Announce once now, and again whenever a page asks. A page that loaded its connector before
  // this script ran would otherwise never learn the wallet exists.
  Object.defineProperty(window, installationKey, {
    value: Object.freeze({ announce }),
    configurable: false,
    writable: false,
  });
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();
