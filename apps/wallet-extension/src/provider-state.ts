import { routeProviderRequest, type RpcContext } from "./rpc.js";

export const PROVIDER_STATE_PORT = "artfi-provider-state";

export interface ProviderAccountsChanged {
  type: "provider.accountsChanged";
  accounts: string[];
}

interface Connection {
  port: ChromeRuntimePort;
  origin: string;
  revision: number;
  lastAccounts?: string[];
  timer?: ReturnType<typeof setTimeout>;
}

/** Read-only state subscriptions; neither a port nor its messages can grant access. */
export class ProviderStateRelay {
  readonly #connections = new Set<Connection>();

  constructor(
    private readonly context: RpcContext,
    private readonly restored: Promise<unknown>,
  ) {}

  connect(port: ChromeRuntimePort): void {
    if (port.name !== PROVIDER_STATE_PORT) return;
    // Identity is supplied only by Chrome. Never accept an origin over onMessage.
    if (!port.sender?.origin) {
      port.disconnect();
      return;
    }
    const connection: Connection = {
      port,
      origin: port.sender.origin,
      revision: 0,
    };
    this.#connections.add(connection);
    port.onDisconnect.addListener(() => this.#remove(connection));
    void this.#refresh(connection);
  }

  refresh(): void {
    for (const connection of this.#connections) void this.#refresh(connection);
  }

  #remove(connection: Connection): void {
    this.#connections.delete(connection);
    clearTimeout(connection.timer);
    connection.revision++;
  }

  async #refresh(connection: Connection): Promise<void> {
    const revision = ++connection.revision;
    clearTimeout(connection.timer);
    try {
      await this.restored;
      if (!this.#current(connection, revision)) return;
      const payload = this.context.payload();
      const result = await routeProviderRequest(
        connection.origin,
        "eth_accounts",
        [],
        this.context,
      );
      if (!this.#current(connection, revision)) return;
      // An asynchronous answer cannot resurrect a payload that was locked/replaced while
      // it was pending, even if its caller has not reached its final refresh yet.
      if (payload !== this.context.payload()) {
        void this.#refresh(connection);
        return;
      }
      let accounts = Array.isArray(result)
        ? result.filter((value): value is string => typeof value === "string")
        : [];
      // Recheck immediately before publishing: expiry/revocation can occur during the await.
      try {
        const now = this.context.now?.() ?? Date.now();
        const grant = this.context.permissions.assert(
          connection.origin,
          "eth_accounts",
          now,
        );
        connection.timer = setTimeout(
          () => void this.#refresh(connection),
          Math.min(grant.expiresAt - now, 2_147_483_647),
        );
      } catch {
        accounts = [];
      }
      this.#publish(connection, accounts);
    } catch {
      // Restoration/router failures disclose no accounts and clear any previously visible state.
      if (this.#current(connection, revision)) this.#publish(connection, []);
    }
  }

  #current(connection: Connection, revision: number): boolean {
    return (
      this.#connections.has(connection) && connection.revision === revision
    );
  }

  #publish(connection: Connection, accounts: string[]): void {
    if (
      connection.lastAccounts?.length === accounts.length &&
      connection.lastAccounts.every((value, index) => value === accounts[index])
    )
      return;
    const message: ProviderAccountsChanged = {
      type: "provider.accountsChanged",
      accounts,
    };
    try {
      connection.port.postMessage(message);
      connection.lastAccounts = [...accounts];
    } catch {
      this.#remove(connection);
    }
  }
}
