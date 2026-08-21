import { describe, expect, it } from "vitest";

import { assertSinPublicChainExecution } from "./runtime-boundary.js";

describe("public-chain execution boundary", () => {
  it("accepts only the explicit SIN execution zone", () => {
    expect(() => assertSinPublicChainExecution("sin")).not.toThrow();
  });

  for (const zone of [undefined, "", "abcdyi", "aivan", "mysql", "SIN"]) {
    it(`rejects ${String(zone)}`, () => {
      expect(() => assertSinPublicChainExecution(zone)).toThrow(/restricted/);
    });
  }
});
