import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { DaoPublishedExecution } from "../../src/components/dao-published-execution";
import {
  UserSessionProvider,
  useUserSession,
} from "../../src/components/user-session-provider";
import { deployment, fixture } from "./wagmi";
declare global {
  interface Window {
    daoFixture: typeof fixture;
  }
}
window.daoFixture = fixture;
function App() {
  const session = useUserSession();
  return (
    <main className="approved-page page-shell">
      <p>
        TEST_ONLY native DAO workflow. No wallet, RPC, signatures or chain
        writes.
      </p>
      <p data-testid="session-state">
        {session.authenticated ? "authenticated" : "unsigned"}
      </p>
      <button onClick={() => fixture.setWallet(1)}>
        Switch TEST_ONLY chain
      </button>
      <button
        onClick={() =>
          fixture.setWallet(
            560048,
            true,
            "0x6666666666666666666666666666666666666666",
          )
        }
      >
        Switch TEST_ONLY account
      </button>
      <button onClick={() => void session.signOut()}>
        End TEST_ONLY session
      </button>
      <DaoPublishedExecution deployment={deployment} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <UserSessionProvider>
    <App />
  </UserSessionProvider>,
);
