import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { CharityEditionCreateFlow } from "../../src/components/charity-edition-create-flow";
import { collection, fixture, fields } from "./wagmi";
window.__ARTFI_PUBLIC_CONFIG__ = {
  NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS: collection,
};
declare global {
  interface Window {
    charityFixture: typeof fixture;
    charityFields: typeof fields;
  }
}
window.charityFixture = fixture;
window.charityFields = fields;
createRoot(document.getElementById("root")!).render(
  <main className="approved-page page-shell">
    <p>
      TEST_ONLY wallet callbacks, receipts and contract reads. No RPC, keys,
      signatures, funds, artwork or actual chain writes.
    </p>
    <CharityEditionCreateFlow />
  </main>,
);
