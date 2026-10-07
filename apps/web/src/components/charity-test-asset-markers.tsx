import { supportedChain } from "@/lib/wagmi";

/**
 * Test-asset markers — `PRD.md` §7.0.
 *
 * §7.0 requires `TESTNET`, `NO REAL-WORLD VALUE` and `NO LEGAL EFFECT` in **four** places: token
 * metadata, contract or series level at deployment, **on screen wherever the set is displayed**,
 * and as a top-level field in the batch manifest. This component is the third. It was missing, and
 * a Hoodi run stopped on it: three of four places is an isolation failure, not a warning.
 *
 * One component for both charity surfaces, for the same reason the rights notice is one: a reader
 * should not have to reconcile two wordings of what they are looking at.
 *
 * **Derived from the chain, not from a flag someone can forget to set.** The markers describe the
 * payload, and the payload is test assets because of the chain it lives on. On a non-test chain
 * they would be a false claim, so nothing renders there — §7.0 governs the test payload and says
 * nothing about a production one.
 *
 * This is site chrome's opposite: the global `testnet-banner` says the *site* is a testnet build,
 * which is a different statement from these assets carrying no value and no legal effect. Leaving
 * the banner to stand for both is what left §7.0's third place empty.
 */

export const charityTestAssetMarkers = [
  "TESTNET",
  "NO REAL-WORLD VALUE",
  "NO LEGAL EFFECT",
] as const;

export function CharityTestAssetMarkers({ className }: { className?: string }) {
  if (!supportedChain.testnet) return null;

  return (
    <p
      className={className ?? "testnet-banner"}
      data-testid="charity-test-asset-markers"
      role="note"
      aria-label="Test asset markers"
    >
      {charityTestAssetMarkers.map((marker) => (
        <span key={marker}>{marker}</span>
      ))}
      Every edition shown here is a test asset on {supportedChain.name}.
    </p>
  );
}
