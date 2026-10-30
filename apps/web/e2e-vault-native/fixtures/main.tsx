import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { DaoCreationFlow } from "../../src/components/dao-creation-flow";
import { addresses, fixture, setup } from "./wagmi";
import type { VaultStage } from "../../src/lib/vault-setup";
window.__ARTFI_PUBLIC_CONFIG__ = {};
declare global {
  interface Window {
    vaultFixture: typeof fixture;
    vaultAddresses: typeof addresses;
  }
}
window.vaultFixture = fixture;
window.vaultAddresses = addresses;
const query = new URL(location.href).searchParams;
const stage = (query.get("stage") || "created") as VaultStage;
fixture.stage = stage;
const key = `artfi:setup:vault:560048:${addresses.owner}`;
if (!sessionStorage.getItem(key)) {
  const data = setup(stage);
  if (stage === "configure") data.intent = undefined;
  sessionStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      id: "test-only-public-record",
      data,
      ...(query.has("unknown")
        ? { pending: { id: "test-only-unknown", step: "approve" } }
        : {}),
    }),
  );
  if (stage !== "configure")
    sessionStorage.setItem(
      `artfi:vault-continuation:560048:${addresses.factory}:${addresses.vault}`,
      JSON.stringify({ version: 1, data, participants: [addresses.owner] }),
    );
}
createRoot(document.getElementById("root")!).render(
  <main className="approved-page page-shell">
    <p>
      TEST_ONLY public Vault bindings, wallet callbacks and chain reads. No RPC,
      keys, signatures, funds or actual chain operations.
    </p>
    <DaoCreationFlow />
  </main>,
);
