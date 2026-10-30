import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RwaSourceRecord } from "../../src/components/rwa-source-record";
import { NativeMarketAnalyticsPanel } from "../../src/components/native-market-analytics";
import { analyticsAssetFixture } from "../../src/test/native-market-analytics-fixture";
import "../../src/app/globals.css";
function Fixture() {
  const [asset, setAsset] = useState(analyticsAssetFixture);
  return (
    <main style={{ maxWidth: 1100, margin: "auto", padding: 12 }}>
      <h1>TEST_ONLY analytics component</h1>
      <p>
        No real assets, authority, wallet or database. Browser transport replies
        are synthetic.
      </p>
      <button
        data-testid="revise-source"
        onClick={() =>
          setAsset((x) => ({
            ...x,
            revision: x.revision + 1,
            binding: {
              ...x.binding,
              fractionTokenAddress:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            },
          }))
        }
      >
        TEST_ONLY revise source
      </button>
      <button
        data-testid="remove-binding"
        onClick={() =>
          setAsset((x) => ({
            ...x,
            revision: x.revision + 1,
            binding: { ...x.binding, marketAddress: undefined },
          }))
        }
      >
        TEST_ONLY remove binding
      </button>
      {new URLSearchParams(window.location.search).has("sourceRecord") && (
        <RwaSourceRecord asset={asset} />
      )}
      <NativeMarketAnalyticsPanel asset={asset} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
