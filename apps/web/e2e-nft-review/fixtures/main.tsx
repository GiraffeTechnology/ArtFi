import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { NftMarket } from "../../src/components/nft-market";
import {
  UserSessionProvider,
  useUserSession,
} from "../../src/components/user-session-provider";
import { fixture } from "./wagmi";
declare global {
  interface Window {
    nftFixture: typeof fixture;
  }
}
window.nftFixture = fixture;
function App() {
  const session = useUserSession();
  return (
    <main className="approved-page page-shell">
      <p>
        TEST_ONLY digital NFT browser workflow. Intercepted HTTP and synthetic
        wallet callbacks; no real assets, cryptographic signatures or
        transactions.
      </p>
      <p data-testid="session-state">
        {session.authenticated ? "authenticated" : "unsigned"}
      </p>
      <NftMarket />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <UserSessionProvider>
    <App />
  </UserSessionProvider>,
);
