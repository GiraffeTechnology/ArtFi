import "../../src/app/globals.css";
import { UserSessionProvider } from "../../src/components/user-session-provider";
import { createRoot } from "react-dom/client";
import { DaoGovernance } from "../../src/components/dao-governance";
import {
  daoActionSession,
  saveSubmittedDaoProposal,
} from "../../src/lib/dao-action-state";
import { fixture } from "./wagmi";
let release: (() => void) | undefined;
const query = new URLSearchParams(location.search);
if (query.get("queued") === "1") {
  fixture.controls.state = 5;
  fixture.controls.eta = 990n;
}
const originalContext = fixture.context();
saveSubmittedDaoProposal(sessionStorage, originalContext, fixture.submitted);
window.daoSelectedFixture = {
  fixture,
  originalBusy: () => daoActionSession(originalContext).getSnapshot().busy,
  hold() {
    release = fixture.holdSimulation();
  },
  release() {
    release?.();
  },
};
declare global {
  interface Window {
    daoSelectedFixture: {
      fixture: typeof fixture;
      originalBusy: () => boolean;
      hold: () => void;
      release: () => void;
    };
  }
}
createRoot(document.getElementById("root")!).render(
  <UserSessionProvider>
    <button onClick={() => fixture.switchWallet()}>
      TEST_ONLY switch wallet
    </button>
    <DaoGovernance deployment={fixture.deployment} />
  </UserSessionProvider>,
);
