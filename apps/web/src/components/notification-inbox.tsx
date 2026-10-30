"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useAccount } from "wagmi";
import { useUserSession } from "./user-session-provider";
import { portfolioSessionKey } from "@/lib/portfolio-session";
import {
  createNotificationInbox,
  type NotificationIdentity,
  type NotificationInboxState,
  type NotificationPreferences,
} from "@/lib/notification-inbox-state";
import { browserNotificationTransport } from "@/lib/notification-transport";
import styles from "./notification-inbox.module.css";
import { NotificationInboxBrowser } from "./notification-inbox-browser";

const serverSnapshot: NotificationInboxState = Object.freeze({
  identity: null,
  status: "signed_out",
  page: null,
  pending: false,
});
const statusText = {
  signed_out: "Sign in with the connected wallet to read notifications.",
  loading: "Loading current notification sources.",
  ready: "Notifications reflect the current indexed sources.",
  error: "Notifications are unavailable. Refresh before acting.",
  reconcile:
    "No change was confirmed. Refresh to reconcile current state before acting.",
  expired: "Your wallet session expired. Sign in again.",
};

export function NotificationInbox() {
  const auth = useUserSession();
  const wallet = useAccount();
  const key = portfolioSessionKey(auth, wallet);
  const session = auth.session;
  if (!key || !session)
    return (
      <section className={styles.panel}>
        <h2>Your private inbox</h2>
        <p>
          Sign in with the connected wallet to read notifications and save
          delivery preferences. Connecting an address alone does not sign you
          in.
        </p>
      </section>
    );
  const identity: NotificationIdentity = {
    address: session.address.toLowerCase(),
    chainId: session.chainId,
    sessionId: session.id,
    expiresAt: Math.min(session.expiresAt, session.accessExpiresAt),
  };
  return (
    <SessionInbox key={`${key}:${identity.expiresAt}`} identity={identity} />
  );
}

function SessionInbox({ identity }: { identity: NotificationIdentity }) {
  const [controller] = useState(() =>
    createNotificationInbox(browserNotificationTransport(), {
      now: Date.now,
      requestKey: () => crypto.randomUUID(),
    }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    () => serverSnapshot,
  );
  const { address, chainId, sessionId, expiresAt } = identity;
  useEffect(() => {
    controller.setIdentity({ address, chainId, sessionId, expiresAt });
    void controller.refresh();
    return () => controller.dispose();
  }, [controller, address, chainId, sessionId, expiresAt]);
  const page = state.page;
  return (
    <div className={styles.workspace}>
      <section
        className={styles.panel}
        aria-busy={state.status === "loading" || state.pending}
      >
        <div className={styles.heading}>
          <h2>Your private inbox</h2>
          <button
            type="button"
            className="wallet-button"
            disabled={
              state.pending || !state.identity || state.status === "loading"
            }
            onClick={() => void controller.refresh()}
          >
            Refresh
          </button>
        </div>
        <p
          role={
            state.status === "error" || state.status === "reconcile"
              ? "alert"
              : "status"
          }
        >
          {statusText[state.status]}
        </p>
        {page && (
          <>
            <p
              className={styles.identity}
              data-no-translate
              data-translation-skip
            >
              {page.address} · Chain {page.chainId}
            </p>
            {!page.chainEventsAvailable && (
              <p>
                Transaction alerts from the indexed chain are unavailable on
                this network. Published system messages remain available.
              </p>
            )}
            <p>
              The inbox shows up to 99 current participant events and the
              current platform notice. Older records remain in transaction
              history.
            </p>
            <NotificationInboxBrowser
              notifications={page.notifications}
              pending={state.pending}
              markRead={controller.markRead}
            />
          </>
        )}
      </section>
      {page && (
        <PreferencesForm
          key={page.preferences.revision}
          preferences={page.preferences}
          pending={state.pending}
          save={controller.savePreferences}
        />
      )}
    </div>
  );
}

function PreferencesForm({
  preferences,
  pending,
  save,
}: {
  preferences: NotificationPreferences;
  pending: boolean;
  save: (input: NotificationPreferences) => Promise<void>;
}) {
  const [transactions, setTransactions] = useState(
    preferences.transactionAlerts,
  );
  const [system, setSystem] = useState(preferences.systemMessageAlerts);
  const changed =
    transactions !== preferences.transactionAlerts ||
    system !== preferences.systemMessageAlerts;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pending && changed)
      void save({
        ...preferences,
        transactionAlerts: transactions,
        systemMessageAlerts: system,
      });
  };
  return (
    <section className={styles.panel}>
      <h2>Delivery preferences</h2>
      <p>
        These settings apply to this wallet and chain. They control this inbox;
        they do not send email or browser push messages.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={pending} className={styles.preferences}>
          <legend>In-app alerts</legend>
          <label>
            <input
              type="checkbox"
              checked={transactions}
              onChange={(event) => setTransactions(event.target.checked)}
            />{" "}
            Transaction alerts
          </label>
          <label>
            <input
              type="checkbox"
              checked={system}
              onChange={(event) => setSystem(event.target.checked)}
            />{" "}
            System messages
          </label>
          <button
            type="submit"
            className="wallet-button"
            disabled={pending || !changed}
          >
            Save preferences
          </button>
        </fieldset>
      </form>
    </section>
  );
}
