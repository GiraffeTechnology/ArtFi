import "../../src/app/globals.css";
import { createRoot } from "react-dom/client";
import { NFTMintConsole } from "../../src/components/nft-mint-console";
import { calls } from "./wagmi";
window.__ARTFI_PUBLIC_CONFIG__ = {};
declare global {
  interface Window {
    mintCalls: typeof calls;
  }
}
window.mintCalls = calls;
const initial =
  new URL(location.href).searchParams.get("standard") === "erc1155"
    ? "erc1155"
    : "erc721";
createRoot(document.getElementById("root")!).render(
  <main className="approved-page page-shell">
    <p>
      TEST_ONLY disconnected wallet. No RPC, signature, chain or artwork upload.
    </p>
    <NFTMintConsole initialStandard={initial} />
  </main>,
);
