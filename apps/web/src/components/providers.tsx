"use client";

import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "@/lib/wallet-config";

import { UserSessionProvider } from "./user-session-provider";

import { LanguageProvider } from "./language-provider";
import { XionganWalletProvider } from "./xiongan-wallet-provider";
import { XionganWalletDisclaimer } from "./xiongan-wallet-disclaimer";

export function Providers({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <XionganWalletProvider>
          <RainbowKitProvider
            modalSize="compact"
            appInfo={{ appName: "ArtFi", disclaimer: XionganWalletDisclaimer }}
          >
            <UserSessionProvider>
              <LanguageProvider>{children}</LanguageProvider>
            </UserSessionProvider>
          </RainbowKitProvider>
        </XionganWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
