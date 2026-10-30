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
import { watchUserSessionDeadlines } from "@/lib/user-session-deadlines";
import type { UserSessionState } from "@/lib/user-session-client-state";
import { renderUserSessionState } from "@/lib/user-session-render-state";

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
  useEffect(() => watchUserSessionDeadlines(userSessionController), []);
  const value = useMemo(
    () => ({
      ...renderUserSessionState(state, { address, chainId, status }),
      signIn: () =>
        userSessionController.signIn((message) =>
          signMessageAsync({ message }),
        ),
      signOut: userSessionController.signOut,
      cancel: userSessionController.cancel,
      refresh: userSessionController.refresh,
    }),
    [state, address, chainId, status, signMessageAsync],
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
