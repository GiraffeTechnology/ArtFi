"use client";

import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";

import {
  fetchXionganWalletConfig,
  walletConfigView,
  type XionganWalletState,
} from "@/lib/xiongan-wallet-config";

export const XionganWalletContext = createContext<{
  state: XionganWalletState;
  refresh: () => void;
}>({ state: { ok: false, code: "LOADING" }, refresh: () => {} });

export function XionganWalletProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: ["xiongan-wallet-deployment-config"],
    queryFn: ({ signal }) => fetchXionganWalletConfig(signal),
    retry: false,
    staleTime: 0,
  });
  return (
    <XionganWalletContext.Provider
      value={{
        state: walletConfigView(query),
        refresh: () => {
          void query.refetch();
        },
      }}
    >
      {children}
    </XionganWalletContext.Provider>
  );
}

export function useXionganWalletConfig() {
  return useContext(XionganWalletContext);
}
