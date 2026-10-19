import { createRoot } from "react-dom/client";
import { CharityEvidenceRecorder } from "../../src/components/charity-evidence-recorder";
import { fixture, target } from "./wagmi";
import "../../src/app/globals.css";
declare global {
  interface Window {
    charityEvidenceFixture: typeof fixture;
  }
}
window.charityEvidenceFixture = fixture;
window.__ARTFI_PUBLIC_CONFIG__ = {
  NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS: target,
};
createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 24, maxWidth: 960, margin: "0 auto" }}>
    <p>
      TEST_ONLY evidence commitments, wallet callbacks and chain reads. No real
      sales, donation, signature, funds, artwork, RPC or chain writes.
    </p>
    <CharityEvidenceRecorder tokenId="7" />
  </main>,
);
