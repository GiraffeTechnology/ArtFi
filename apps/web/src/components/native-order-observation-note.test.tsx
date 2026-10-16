import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeOrderObservationNote } from "./native-order-observation-note";
import type { NativeOrderObservation } from "@/lib/native-order-observation";

describe("native-order observation attribution", () => {
  it("shows exact block and clock provenance without a settlement or physical-rights claim", () => {
    const observation: NativeOrderObservation = {
      chainId: 560048,
      blockNumber: "50",
      blockHash: "0x" + "a".repeat(64),
      blockTimestamp: "1500",
      observedAt: 10000,
      states: {},
    };
    const html = renderToStaticMarkup(
      createElement(NativeOrderObservationNote, { observation }),
    );
    for (const text of [
      observation.blockHash,
      "1500",
      "1970-01-01T00:00:10.000Z",
      "same Hoodi block",
      "Snapshot age is unavailable",
      "not reserved availability or finality",
      "settlement or withdrawal",
      "does not prove registry transfer or physical delivery",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Confirm in wallet");
    expect(html).not.toContain("Settle order");
  });
});
