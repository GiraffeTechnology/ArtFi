"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  subscribeToUserSessionChanges,
  userSessionController,
} from "@/lib/user-session-client";
import type { UserSessionState } from "@/lib/user-session-client-state";

type UserSessionContextValue = UserSessionState & {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  cancel: () => Promise<void>;
  refresh: typeof userSessionController.refresh;
};
const UserSessionContext = createContext<UserSessionContextValue | null>(null);

export function UserSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { address, chainId, status } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const state = useSyncExternalStore(
    userSessionController.subscribe,
    userSessionController.getSnapshot,
    userSessionController.getServerSnapshot,
  );
  useEffect(() => {
    userSessionController.setWallet({ address, chainId, status });
  }, [address, chainId, status]);
  useEffect(() => {
    void userSessionController.restore().catch(() => undefined);
  }, []);
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "visible")
        void userSessionController.recheck().catch(() => undefined);
    };
    const unsubscribe = subscribeToUserSessionChanges(recheck);
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, []);
  useEffect(() => {
    const session = state.session;
    if (!session) return;
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const remaining = session.expiresAt - Date.now();
      if (remaining <= 0)
        userSessionController.expireSession(session.id, session.expiresAt);
      else timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => clearTimeout(timer);
  }, [state.session]);
  const value = useMemo(
    () => ({
      ...state,
      signIn: () =>
        userSessionController.signIn((message) =>
          signMessageAsync({ message }),
        ),
      signOut: userSessionController.signOut,
      cancel: userSessionController.cancel,
      refresh: userSessionController.refresh,
    }),
    [state, signMessageAsync],
  );
  return (
    <UserSessionContext.Provider value={value}>
      {children}
    </UserSessionContext.Provider>
  );
}
export function useUserSession() {
  const context = useContext(UserSessionContext);
  if (!context) throw new Error("UserSessionProvider is required.");
  return context;
}
