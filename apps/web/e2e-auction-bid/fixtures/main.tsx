import { createRoot } from "react-dom/client";
import { AuctionMarket } from "../../src/components/auction-market";
import { UserSessionProvider } from "../../src/components/user-session-provider";
import { fixture } from "./wagmi";
window.__ARTFI_PUBLIC_CONFIG__ = {
  NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS: fixture.market,
  NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS: fixture.asset,
};
window.auctionBidFixture = fixture;
declare global {
  interface Window {
    auctionBidFixture: typeof fixture;
  }
}
createRoot(document.getElementById("root")!).render(
  <UserSessionProvider>
    <AuctionMarket />
  </UserSessionProvider>,
);
