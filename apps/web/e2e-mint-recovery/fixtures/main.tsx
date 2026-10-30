import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { RwaCreateFlow } from "../../src/components/rwa-create-flow";
import { setupRecoverySession } from "../../src/lib/setup-recovery";
import {
  isMintRecovery,
  type MintRecovery,
} from "../../src/lib/rwa-mint-recovery";
import { wallet, fixture, intent } from "./wagmi";
window.__ARTFI_PUBLIC_CONFIG__ = {};
declare global {
  interface Window {
    mintRecoveryFixture: typeof fixture;
  }
}
window.mintRecoveryFixture = fixture;
// Seed an existing interrupted request through the actual journal API, never its internal encoding.
const session = setupRecoverySession<MintRecovery>(
  `mint:560048:${wallet.toLowerCase()}`,
  isMintRecovery,
);
session.restore(() => sessionStorage);
if (!session.getSnapshot().record) {
  const lease = session.begin();
  if (lease === undefined) throw Error("TEST_ONLY journal locked");
  session.save(lease, {
    wallet,
    chainId: 560048,
    draft: {
      name: "TEST_ONLY artwork",
      artist: "Synthetic",
      year: 2026,
      medium: "Synthetic",
      location: "TEST_ONLY",
      description: "No real asset or rights",
    },
    digest: "a".repeat(64),
    idempotencyKey: "test-only-mint",
    uploadId: "test-only-upload",
    intent,
  });
  session.awaitWallet(lease, "mint");
  session.finish(lease);
}
createRoot(document.getElementById("root")!).render(
  <main className="approved-page page-shell">
    <p>
      TEST_ONLY existing interrupted mint. No new wallet request, signature, RPC
      or chain operation.
    </p>
    <RwaCreateFlow />
  </main>,
);
