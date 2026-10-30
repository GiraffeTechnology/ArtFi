import React from "react";
import { createRoot } from "react-dom/client";
import { LiveMarketCatalog } from "../../src/components/live-market-catalog";
declare global {
  interface Window {
    marketCatalogFixture: { unmount: () => void };
  }
}
const root = createRoot(document.getElementById("root")!);
window.marketCatalogFixture = { unmount: () => root.unmount() };
root.render(<LiveMarketCatalog />);
