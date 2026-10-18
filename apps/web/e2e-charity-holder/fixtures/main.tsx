import "../../src/app/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  WagmiProvider,
  createConfig,
  createConnector,
  http,
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { mock } from "wagmi/connectors";
import { hoodi, mainnet } from "wagmi/chains";
import { CharityHolderAccess } from "../../src/components/charity-holder-access";
const first = "0x6666666666666666666666666666666666666666" as const;
const second = "0x7777777777777777777777777777777777777777" as const;
const signature = ("0x" + "12".repeat(65)) as `0x${string}`;
type Controls = {
  signatures: number;
  messages: unknown[];
  signMode: "success" | "reject" | "hold";
  releaseSignature?: () => void;
  connect?: () => void;
};
declare global {
  interface Window {
    charityFixture: Controls;
  }
}
window.charityFixture = { signatures: 0, messages: [], signMode: "success" };
function testConnector(account: typeof first | typeof second, label: string) {
  return createConnector((config) => {
    const connector = mock({ accounts: [account] })(config);
    return {
      ...connector,
      id: "test-only-" + label,
      name: "TEST_ONLY " + label,
      async getProvider() {
        const provider = await connector.getProvider();
        return new Proxy(provider, {
          get(target, key, receiver) {
            if (key === "request")
              return async (input: {
                method: string;
                params?: readonly unknown[];
              }) => {
                if (input.method === "personal_sign") {
                  const f = window.charityFixture;
                  f.signatures += 1;
                  f.messages.push(input.params);
                  if (f.signMode === "reject")
                    throw Error("TEST_ONLY signature declined");
                  if (f.signMode === "hold")
                    await new Promise<void>((resolve) => {
                      f.releaseSignature = resolve;
                    });
                  return signature;
                }
                return Reflect.apply(target.request, target, [input]);
              };
            return Reflect.get(target, key, receiver);
          },
        });
      },
    };
  });
}
const rpc = new URL("/test-only-rpc", location.href).href;
const config = createConfig({
  chains: [
    { ...hoodi, rpcUrls: { default: { http: [rpc] } } },
    { ...mainnet, rpcUrls: { default: { http: [rpc] } } },
  ],
  connectors: [testConnector(first, "A"), testConnector(second, "B")],
  transports: { [hoodi.id]: http(rpc), [mainnet.id]: http(rpc) },
});
const queries = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
function App() {
  const wallet = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const [tokenId, setTokenId] = useState("7");
  const [visible, setVisible] = useState(true);
  const connect = async (index: number) => {
    if (wallet.isConnected) await disconnectAsync();
    await connectAsync({ connector: connectors[index]!, chainId: hoodi.id });
  };
  window.charityFixture.connect = () => {
    void connect(0);
  };
  return (
    <main className="approved-page page-shell">
      <header>
        <p>
          TEST_ONLY synthetic challenge/grant/file service and fixed mock
          EIP1193 signature callback. No real signature, ownership, file or
          chain evidence.
        </p>
        <p
          style={{ overflowWrap: "anywhere" }}
          data-testid="actual-wallet-state"
        >
          {wallet.status}:{wallet.address ?? "none"}:{wallet.chainId ?? "none"}
        </p>
        <p data-testid="selected-edition">{tokenId}</p>
        <button onClick={() => void connect(0)}>Connect TEST_ONLY A</button>
        <button onClick={() => void connect(1)}>Connect TEST_ONLY B</button>
        <button onClick={() => void disconnectAsync()}>
          Disconnect TEST_ONLY
        </button>
        <button onClick={() => setTokenId((v) => (v === "7" ? "8" : "7"))}>
          Switch TEST_ONLY edition
        </button>
        <button onClick={() => setVisible((v) => !v)}>
          Toggle TEST_ONLY screen
        </button>
        <button onClick={() => void switchChainAsync({ chainId: 1 })}>
          Switch TEST_ONLY chain
        </button>
      </header>
      {visible ? (
        <CharityHolderAccess tokenId={tokenId} />
      ) : (
        <p>TEST_ONLY screen removed</p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <WagmiProvider config={config} reconnectOnMount={false}>
    <QueryClientProvider client={queries}>
      <App />
    </QueryClientProvider>
  </WagmiProvider>,
);
