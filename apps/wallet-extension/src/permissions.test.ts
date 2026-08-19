import { describe, expect, it } from "vitest";

import { PermissionController } from "./permissions.js";
import { assertSafeOrigin } from "./phishing.js";

describe("origin and permission controls", () => {
  it("normalizes HTTPS origins and expires grants", () => {
    const permissions = new PermissionController();
    const record = permissions.grant(
      "https://app.artfi.test/path",
      ["eth_accounts", "eth_sendTransaction"],
      1_000,
      60_000,
    );
    expect(record.origin).toBe("https://app.artfi.test");
    expect(
      permissions.assert(record.origin, "eth_sendTransaction", 30_000),
    ).toEqual(record);
    expect(() =>
      permissions.assert(record.origin, "eth_sendTransaction", 61_001),
    ).toThrow(/not authorized/);
  });

  it("blocks insecure, punycode, and denied origins", () => {
    expect(() => assertSafeOrigin("http://artfi.test")).toThrow(/HTTPS/);
    expect(() => assertSafeOrigin("https://xn--artf-epa.test")).toThrow(
      /manual security review/,
    );
    expect(() => assertSafeOrigin("https://wallet.example-phish.test")).toThrow(
      /blocked/,
    );
    expect(assertSafeOrigin("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });
});
