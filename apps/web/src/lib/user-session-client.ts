"use client";

import { isAddress, type Hex } from "viem";
import { hoodi } from "viem/chains";
import {
  authenticatedSession,
  initialUserSessionState,
  sameWallet,
  type SessionWallet,
  type UserSession,
  type UserSessionState,
} from "@/lib/user-session-client-state";

export type {
  UserSession,
  UserSessionState,
} from "@/lib/user-session-client-state";
export class ClientSessionError extends Error {
  constructor(
    public status: number,
    message: string,
    public cookiesMayHaveChanged = false,
  ) {
    super(message);
  }
}
export type SessionAPI = (
  action: "session" | "challenge" | "verify" | "refresh" | "logout",
  body?: unknown,
) => Promise<unknown>;
export type SessionSerializer = <T>(operation: () => Promise<T>) => Promise<T>;
let cookieQueue: Promise<unknown> = Promise.resolve();

/** One cookie writer per origin; wallet prompts deliberately run outside this lock. */
export function serializeUserCookieMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> =>
    typeof navigator !== "undefined" && navigator.locks
      ? await navigator.locks.request("artfi-user-session-cookies", operation)
      : await operation();
  const result = cookieQueue.then(run, run);
  cookieQueue = result.catch(() => undefined);
  return result;
}

const sessionChannelName = "artfi-user-session-changes";
function notifyUserSessionChanged() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return;
  try {
    const channel = new BroadcastChannel(sessionChannelName);
    channel.postMessage({ type: "session-changed" });
    channel.close();
  } catch {
    /* Optional notifications must not turn confirmed authentication into a failure. */
  }
}
export function subscribeToUserSessionChanges(listener: () => void) {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return () => undefined;
  try {
    const channel = new BroadcastChannel(sessionChannelName);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (
        event.data &&
        typeof event.data === "object" &&
        (event.data as { type?: unknown }).type === "session-changed"
      )
        listener();
    };
    return () => channel.close();
  } catch {
    return () => undefined;
  }
}

export const browserSessionAPI: SessionAPI = async (action, body) => {
  let response: Response;
  try {
    response = await fetch(`/api/user/auth/${action}`, {
      method: action === "session" ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers:
        action === "session"
          ? undefined
          : { "content-type": "application/json" },
      body: action === "session" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new ClientSessionError(
      503,
      "Wallet sign-in is unavailable. Try again.",
      action !== "session",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ClientSessionError(
      response.status,
      response.status === 401
        ? "Sign in with your wallet to continue."
        : "Wallet sign-in is unavailable. Try again.",
    );
  }
  const text = await response.text();
  if (text.length > 16_384)
    throw new ClientSessionError(
      503,
      "Invalid wallet-session response.",
      action !== "session",
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new ClientSessionError(
      503,
      "Invalid wallet-session response.",
      action !== "session",
    );
  }
};

function sessionFrom(value: unknown): UserSession {
  const session = (value as { session?: UserSession } | null)?.session;
  if (
    !session ||
    typeof session.id !== "string" ||
    !isAddress(session.address) ||
    session.chainId !== hoodi.id ||
    !Number.isSafeInteger(session.expiresAt) ||
    session.expiresAt <= Date.now() ||
    !Number.isSafeInteger(session.accessExpiresAt) ||
    session.accessExpiresAt <= Date.now()
  )
    throw new ClientSessionError(401, "Sign in with your wallet to continue.");
  // Only the public session fields cross into React state.
  return {
    id: session.id,
    address: session.address,
    chainId: session.chainId,
    expiresAt: session.expiresAt,
    accessExpiresAt: session.accessExpiresAt,
  };
}
function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Wallet sign-in is unavailable. Try again.";
}

export class ClientSessionController {
  private state: UserSessionState = initialUserSessionState;
  private wallet: SessionWallet = { status: "disconnected" };
  private confirmedWallet: SessionWallet | undefined;
  private listeners = new Set<() => void>();
  private restoreFlight: Promise<UserSession | null> | undefined;
  private retirementPending = false;
  constructor(
    private api: SessionAPI = browserSessionAPI,
    private serialize: SessionSerializer = serializeUserCookieMutation,
    private notify: () => void = notifyUserSessionChanged,
  ) {}
  getSnapshot = () => this.state;
  getServerSnapshot = () => initialUserSessionState;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<UserSessionState>) {
    this.state = {
      ...this.state,
      ...update,
      walletStatus: this.wallet.status,
      signOutPending: this.retirementPending,
    };
    this.state.authenticated = authenticatedSession(
      this.state.session,
      this.wallet,
    );
    this.listeners.forEach((listener) => listener());
  }
  private invalidate(detail = "") {
    this.publish({
      revision: this.state.revision + 1,
      session: null,
      signingIn: false,
      busy: false,
      detail,
    });
  }
  private markRetirement() {
    this.retirementPending = true;
    this.publish({});
  }
  private async retire() {
    if (!this.retirementPending) return;
    await this.api("logout", {});
    this.retirementPending = false;
    this.publish({});
    this.notify();
  }
  private mutate<T>(operation: () => Promise<T>) {
    return this.serialize(async () => {
      await this.retire();
      return operation();
    });
  }
  setWallet(wallet: SessionWallet) {
    const previous = this.confirmedWallet;
    this.wallet = wallet;
    if (wallet.status === "connected") this.confirmedWallet = wallet;
    const changed =
      wallet.status === "connected" &&
      ((previous?.address &&
        (previous.address.toLowerCase() !== wallet.address?.toLowerCase() ||
          previous.chainId !== wallet.chainId)) ||
        (this.state.session &&
          !sameWallet(this.state.session, wallet.address, wallet.chainId)));
    if (changed) {
      this.invalidate("Sign in with the connected wallet.");
      this.markRetirement();
      void this.mutate(async () => undefined).catch((error) =>
        this.publish({ detail: message(error) }),
      );
    } else if (wallet.status === "disconnected" && this.state.signingIn) {
      this.invalidate("Reconnect your wallet to sign in.");
      this.markRetirement();
      void this.mutate(async () => undefined).catch((error) =>
        this.publish({ detail: message(error) }),
      );
    } else this.publish({});
  }
  restore = (): Promise<UserSession | null> => this.restoreSession(false);
  recheck = (): Promise<UserSession | null> => {
    if (this.state.busy || this.state.signingIn || this.retirementPending)
      return Promise.resolve(null);
    return this.restoreSession(true);
  };
  expireSession = (id: string, expiresAt: number) => {
    if (
      this.state.session?.id === id &&
      this.state.session.expiresAt === expiresAt &&
      Date.now() >= expiresAt
    )
      this.invalidate("Your wallet session expired. Sign in again.");
  };
  private restoreSession(background: boolean): Promise<UserSession | null> {
    if (this.restoreFlight) return this.restoreFlight;
    const revision = this.state.revision;
    const flight = this.serialize(async () => {
      if (background) {
        if (this.state.busy || this.state.signingIn || this.retirementPending)
          return null;
      } else await this.retire();
      let session: UserSession;
      try {
        try {
          session = sessionFrom(await this.api("session"));
        } catch (error) {
          if (!(error instanceof ClientSessionError) || error.status !== 401)
            throw error;
          session = sessionFrom(await this.api("refresh", {}));
        }
      } catch (error) {
        if (revision === this.state.revision) {
          if (error instanceof ClientSessionError && error.status === 401) {
            if (this.state.session) this.invalidate();
            else this.publish({ session: null, detail: "" });
          } else this.publish({ detail: message(error) });
        }
        if (error instanceof ClientSessionError && error.status === 401)
          return null;
        throw error;
      }
      if (revision !== this.state.revision) {
        // Only an explicit local retirement may revoke after a stale response.
        // A delayed cross-tab notification must never revoke the current cookies.
        if (!background && this.retirementPending) await this.retire();
        return null;
      }
      if (
        this.wallet.status === "connected" &&
        !sameWallet(session, this.wallet.address, this.wallet.chainId)
      ) {
        // The shared cookies may belong to a newer session in another tab.
        this.invalidate("Sign in with the connected wallet.");
        return null;
      }
      if (this.state.session && this.state.session.id !== session.id)
        this.invalidate();
      this.publish({ session, detail: "" });
      return session;
    });
    this.restoreFlight = flight;
    void flight
      .finally(() => {
        if (this.restoreFlight === flight) this.restoreFlight = undefined;
      })
      .catch(() => undefined);
    return flight;
  }
  refresh = this.restore;
  signIn = async (signMessage: (message: string) => Promise<Hex>) => {
    if (this.state.signingIn) return;
    if (
      this.wallet.status !== "connected" ||
      !this.wallet.address ||
      this.wallet.chainId !== hoodi.id
    )
      throw new ClientSessionError(
        400,
        "Connect a wallet on Hoodi to sign in.",
      );
    const address = this.wallet.address.toLowerCase();
    const chainId = this.wallet.chainId;
    const revision = this.state.revision + 1;
    if (this.state.session) this.markRetirement();
    this.publish({
      revision,
      session: null,
      signingIn: true,
      busy: true,
      detail: "",
    });
    try {
      const challenge = await this.mutate(async () => {
        if (revision !== this.state.revision) return null;
        return (await this.api("challenge", { address, chainId })) as {
          address: string;
          chainId: number;
          message: string;
          expiresAt: number;
        };
      });
      if (!challenge || revision !== this.state.revision) return;
      if (
        !sameWallet(challenge, address, chainId) ||
        typeof challenge.message !== "string" ||
        challenge.message.length > 4_096 ||
        challenge.expiresAt <= Date.now()
      )
        throw new ClientSessionError(503, "Invalid wallet challenge.");
      const signature = await signMessage(challenge.message);
      if (revision !== this.state.revision) return;
      await this.mutate(async () => {
        if (revision !== this.state.revision) return;
        let result: unknown;
        try {
          result = await this.api("verify", { address, chainId, signature });
        } catch (error) {
          // A known HTTP rejection did not write cookies. They may belong to a
          // newer session from another tab; do not revoke that session.
          if (
            !(error instanceof ClientSessionError) ||
            error.cookiesMayHaveChanged
          ) {
            this.markRetirement();
            await this.retire();
          }
          throw error;
        }
        if (revision !== this.state.revision) {
          // Verification may have already set cookies. Revoke before releasing the shared lock.
          this.markRetirement();
          await this.retire();
          return;
        }
        try {
          const session = sessionFrom(result);
          if (!sameWallet(session, address, chainId))
            throw new ClientSessionError(403, "The signed-in wallet changed.");
          this.publish({ session, detail: "" });
          this.notify();
        } catch (error) {
          this.markRetirement();
          await this.retire();
          throw error;
        }
      });
    } catch (error) {
      if (revision === this.state.revision)
        this.publish({ detail: message(error) });
    } finally {
      if (revision === this.state.revision)
        this.publish({ busy: false, signingIn: false });
    }
  };
  signOut = async () => {
    this.invalidate();
    const revision = this.state.revision;
    this.markRetirement();
    this.publish({ busy: true });
    try {
      await this.mutate(async () => undefined);
    } catch (error) {
      if (revision === this.state.revision)
        this.publish({
          detail:
            "Sign-out could not be confirmed. Try again before signing in.",
          busy: false,
        });
      throw error;
    } finally {
      if (revision === this.state.revision) this.publish({ busy: false });
    }
  };
  cancel = this.signOut;
  assertTradingSession = async (address: string, chainId: number) => {
    const revision = this.state.revision;
    if (
      this.wallet.status !== "connected" ||
      !sameWallet(
        { address: address as `0x${string}`, chainId },
        this.wallet.address,
        this.wallet.chainId,
      )
    )
      throw new ClientSessionError(
        401,
        "Connect the signed-in wallet to continue.",
      );
    const session = await this.restore();
    if (
      revision !== this.state.revision ||
      !session ||
      !sameWallet(session, address, chainId) ||
      this.wallet.status !== "connected"
    )
      throw new ClientSessionError(
        401,
        "Sign in with the connected wallet to continue.",
      );
    return session;
  };
}

export const userSessionController = new ClientSessionController();
export const assertTradingSession = (address: string, chainId: number) =>
  userSessionController.assertTradingSession(address, chainId);
