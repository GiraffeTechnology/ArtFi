import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { RevenueClaims } from "../../src/components/revenue-claims";
import {
  UserSessionProvider,
  useUserSession,
} from "../../src/components/user-session-provider";
import { fixture } from "./wagmi";
window.__ARTFI_PUBLIC_CONFIG__ = {
  NEXT_PUBLIC_ARTFI_REVENUE_DISTRIBUTOR_ADDRESS:
    "0x1000000000000000000000000000000000000001",
  NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS:
    "0x1000000000000000000000000000000000000002",
};
declare global {
  interface Window {
    revenueFixture: typeof fixture;
  }
}
window.revenueFixture = fixture;
function App() {
  const session = useUserSession();
  return (
    <main className="approved-page page-shell">
      <p>
        TEST_ONLY wallet and contract read seams; no signatures, RPC, funds or
        chain operations.
      </p>
      <p data-testid="session-state">
        {session.authenticated ? "authenticated" : "unsigned"}
      </p>
      <button onClick={() => fixture.setWallet(1)}>
        Switch TEST_ONLY chain
      </button>
      <button onClick={() => fixture.setWallet(560048, false)}>
        Disconnect TEST_ONLY wallet
      </button>
      <button onClick={() => void session.signOut()}>
        End TEST_ONLY session
      </button>
      <RevenueClaims />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <UserSessionProvider>
    <App />
  </UserSessionProvider>,
);
