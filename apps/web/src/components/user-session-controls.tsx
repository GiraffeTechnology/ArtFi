"use client";

import { useUserSession } from "@/components/user-session-provider";

export function UserSessionControls() {
  const auth = useUserSession();
  return (
    <div className="user-session-controls" aria-label="Wallet account session">
      {auth.session ? (
        <>
          <span>
            {auth.authenticated ? "Signed in" : "Wallet session saved"}
          </span>{" "}
          <button
            className="wallet-button"
            type="button"
            disabled={auth.busy && !auth.signingIn}
            onClick={() => void auth.signOut().catch(() => undefined)}
          >
            Sign out
          </button>
        </>
      ) : auth.signingIn ? (
        <>
          <span role="status">Confirm sign-in in your wallet.</span>{" "}
          <button
            className="wallet-button"
            type="button"
            onClick={() => void auth.cancel().catch(() => undefined)}
          >
            Cancel
          </button>
        </>
      ) : auth.signOutPending ? (
        <button
          className="wallet-button"
          type="button"
          disabled={auth.busy}
          onClick={() => void auth.signOut().catch(() => undefined)}
        >
          Retry sign out
        </button>
      ) : (
        <button
          className="wallet-button"
          type="button"
          disabled={auth.busy || auth.walletStatus !== "connected"}
          onClick={() => void auth.signIn().catch(() => undefined)}
        >
          Sign in
        </button>
      )}
      {auth.detail && <p role="status">{auth.detail}</p>}
    </div>
  );
}
