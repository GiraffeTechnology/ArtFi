import { describe, expect, it } from "vitest";

import {
  MINIMUM_VAULT_PASSWORD,
  normalizeConnector,
  vaultSubmission,
} from "./vault-form.js";

const address = "0x00112233445566778899aabbccddeeff00112233";
const password = "correct horse battery";

describe("vault form submission", () => {
  it("creates the vault with its first account when none is configured", () => {
    // Without this path nothing in the extension ever sends vault.create, so unlockedPayload stays
    // null and every eth_requestAccounts fails however the provider and grants are set up.
    expect(
      vaultSubmission({
        configured: false,
        password,
        address,
        connector: "hardware",
      }),
    ).toEqual({
      kind: "create",
      password,
      payload: {
        accounts: [{ address, connector: "hardware", label: "Primary" }],
        sessions: [],
        revision: 1,
      },
    });
  });

  it("unlocks an existing vault rather than recreating it", () => {
    // Re-creating would discard the stored descriptors; a password field must not be able to do
    // that by accident.
    expect(
      vaultSubmission({
        configured: true,
        password,
        address: "",
        connector: "hardware",
      }),
    ).toEqual({ kind: "unlock", password });
  });

  it("refuses a password the vault itself would reject", () => {
    const short = "x".repeat(MINIMUM_VAULT_PASSWORD - 1);
    expect(
      vaultSubmission({
        configured: false,
        password: short,
        address,
        connector: "hardware",
      }),
    ).toEqual({
      kind: "problem",
      reason: `the vault password must contain at least ${MINIMUM_VAULT_PASSWORD} characters`,
    });
  });

  it("refuses to create a vault without a usable address", () => {
    for (const candidate of [
      "",
      "0xnothex",
      address.slice(0, -1),
      "not an address",
    ]) {
      expect(
        vaultSubmission({
          configured: false,
          password,
          address: candidate,
          connector: "hardware",
        }),
      ).toEqual({
        kind: "problem",
        reason: "an account address is required to create the vault",
      });
    }
  });

  it("trims a pasted address and keeps both connector kinds", () => {
    const created = vaultSubmission({
      configured: false,
      password,
      address: `  ${address}  `,
      connector: "walletconnect",
    });
    expect(created).toMatchObject({
      kind: "create",
      payload: {
        accounts: [{ address, connector: "walletconnect" }],
      },
    });
    expect(normalizeConnector("hardware")).toBe("hardware");
    expect(normalizeConnector("walletconnect")).toBe("walletconnect");
    // An unexpected value must not become a third connector kind.
    expect(normalizeConnector("something-else")).toBe("hardware");
  });
});
