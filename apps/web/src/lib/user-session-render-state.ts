import {
  authenticatedSession,
  type SessionWallet,
  type UserSessionState,
} from "./user-session-client-state";

/** Bind each render to the live wallet before the controller's effect runs.
 * This is a display projection, never a session issue, refresh or revocation.
 * Keep saved session/retirement state so disconnected sign-out remains usable.
 */
export function renderUserSessionState(
  state: UserSessionState,
  wallet: SessionWallet,
): UserSessionState {
  return {
    ...state,
    walletStatus: wallet.status,
    authenticated:
      state.authenticated &&
      !state.signOutPending &&
      authenticatedSession(state.session, wallet),
  };
}
