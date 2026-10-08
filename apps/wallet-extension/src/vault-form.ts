import type { AccountDescriptor, VaultPayload } from "./vault.js";

/**
 * What the popup's vault form should send.
 *
 * Extracted from the popup so it can be tested. The provider, the site grant and the page
 * injection are all worthless without this path: an account only reaches a page from an unlocked
 * vault, and nothing else in the extension sends `vault.create` or `vault.unlock`. A provider that
 * announces itself while every `eth_requestAccounts` fails is a surface that renders and cannot
 * perform its function.
 */

const addressPattern = /^0x[0-9a-fA-F]{40}$/;

/** Mirrors `deriveKey` in `vault.ts`, which refuses anything shorter. */
export const MINIMUM_VAULT_PASSWORD = 12;

export type VaultConnector = AccountDescriptor["connector"];

export interface VaultFormInput {
  readonly configured: boolean;
  readonly password: string;
  readonly address: string;
  readonly connector: string;
}

export type VaultSubmission =
  | { kind: "create"; password: string; payload: VaultPayload }
  | { kind: "unlock"; password: string }
  | { kind: "problem"; reason: string };

/** Only the two descriptor kinds the vault defines; anything else falls back to hardware. */
export function normalizeConnector(value: string): VaultConnector {
  return value === "walletconnect" ? "walletconnect" : "hardware";
}

export function vaultSubmission(input: VaultFormInput): VaultSubmission {
  const password = input.password;
  if (password.length < MINIMUM_VAULT_PASSWORD) {
    return {
      kind: "problem",
      reason: `the vault password must contain at least ${MINIMUM_VAULT_PASSWORD} characters`,
    };
  }

  // An existing vault is only ever opened. Re-creating it here would discard the stored
  // descriptors, which is not something a password field should be able to do by accident.
  if (input.configured) return { kind: "unlock", password };

  const address = input.address.trim();
  if (!addressPattern.test(address)) {
    return {
      kind: "problem",
      reason: "an account address is required to create the vault",
    };
  }

  return {
    kind: "create",
    password,
    payload: {
      accounts: [
        {
          address: address as `0x${string}`,
          connector: normalizeConnector(input.connector),
          label: "Primary",
        },
      ],
      // No session is invented here, and no key material exists to store: a descriptor records
      // which address an approved external signer holds.
      sessions: [],
      revision: 1,
    },
  };
}
