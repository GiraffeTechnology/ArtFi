import {
  authenticatedSession,
  type SessionWallet,
  type UserSessionState,
} from "./user-session-client-state";

/** Check the live wallet in render, before the provider's wallet-change effect runs. */
export function portfolioSessionKey(
  auth: Pick<UserSessionState, "authenticated" | "session" | "signOutPending">,
  wallet: SessionWallet,
): string | undefined {
  if (
    !auth.authenticated ||
    auth.signOutPending ||
    !auth.session ||
    !authenticatedSession(auth.session, wallet)
  )
    return undefined;
  return `${auth.session.id}:${auth.session.address.toLowerCase()}:${auth.session.chainId}`;
}
