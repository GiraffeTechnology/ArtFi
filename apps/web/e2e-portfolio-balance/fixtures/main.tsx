import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  WagmiProvider,
  createConfig,
  http,
  useAccount,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { mock } from "wagmi/connectors";
import { hoodi, mainnet } from "wagmi/chains";
import { PortfolioWallet } from "../../src/components/portfolio-wallet";
import {
  UserSessionProvider,
  useUserSession,
} from "../../src/components/user-session-provider";
import { userSessionController } from "../../src/lib/user-session-client";

const account = "0x6666666666666666666666666666666666666666" as const;
const rpc = new URL("/test-only-rpc", location.href).href;
const config = createConfig({
  chains: [
    { ...hoodi, rpcUrls: { default: { http: [rpc] } } },
    { ...mainnet, rpcUrls: { default: { http: [rpc] } } },
  ],
  connectors: [mock({ accounts: [account] })],
  transports: { [hoodi.id]: http(rpc), [mainnet.id]: http(rpc) },
});
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

declare global {
  interface Window {
    portfolioFixture: { debug(): unknown };
  }
}
window.portfolioFixture = {
  debug: () => ({
    chains: config.chains.map((chain) => ({
      id: chain.id,
      url: chain.rpcUrls.default.http,
    })),
    connectedChain: config.state.chainId,
    session: userSessionController.getSnapshot(),
    queries: queries
      .getQueryCache()
      .getAll()
      .map((query) => ({
        key: query.queryKey,
        status: query.state.status,
        fetchStatus: query.state.fetchStatus,
        observers: query.getObserversCount(),
        hasData: query.state.data !== undefined,
        error:
          query.state.error instanceof Error
            ? query.state.error.message
            : query.state.error,
      })),
  }),
};
function Controls() {
  const wallet = useAccount();
  const session = useUserSession();
  const query = useQueryClient();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  return (
    <header>
      <p>
        TEST_ONLY HTTP session and RPC fixtures; no real wallet control or
        funds.
      </p>
      <p data-testid="real-wallet-state">
        {wallet.status}:{wallet.chainId ?? "none"}
      </p>
      <p data-testid="real-session-state">
        {session.authenticated ? "authenticated" : "unsigned"}
      </p>
      <button onClick={() => void userSessionController.restore()}>
        Restore TEST_ONLY session
      </button>
      <button
        onClick={() => void query.invalidateQueries({ queryKey: ["balance"] })}
      >
        Refresh TEST_ONLY balance
      </button>
      <button onClick={() => void session.signOut()}>
        End TEST_ONLY session
      </button>
      <button onClick={() => disconnect()}>Disconnect TEST_ONLY wallet</button>
      <button onClick={() => void switchChainAsync({ chainId: 1 })}>
        Switch TEST_ONLY chain
      </button>
    </header>
  );
}
createRoot(document.getElementById("root")!).render(
  <WagmiProvider config={config} reconnectOnMount={false}>
    <QueryClientProvider client={queries}>
      <UserSessionProvider>
        <main className="approved-page page-shell">
          <Controls />
          <PortfolioWallet />
        </main>
      </UserSessionProvider>
    </QueryClientProvider>
  </WagmiProvider>,
);
