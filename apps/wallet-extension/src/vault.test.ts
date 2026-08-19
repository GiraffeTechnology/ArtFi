import { describe, expect, it } from "vitest";

import {
  openVault,
  sealVault,
  VAULT_ITERATIONS,
  type VaultPayload,
} from "./vault.js";

const payload: VaultPayload = {
  accounts: [
    {
      address: "0x1111111111111111111111111111111111111111",
      connector: "hardware",
      label: "Test ledger",
    },
  ],
  sessions: [
    {
      topic: "topic-test",
      relayUrl: "wss://relay.example",
      sessionKey: "sensitive-session-key",
      expiresAt: 2_000_000_000_000,
    },
  ],
  revision: 1,
};

describe("encrypted connector vault", () => {
  it("round-trips metadata using versioned WebCrypto parameters", async () => {
    const sealed = await sealVault(payload, "correct horse battery staple");
    expect(sealed.algorithm).toBe("AES-GCM");
    expect(sealed.kdf).toBe("PBKDF2-SHA256");
    expect(sealed.iterations).toBe(VAULT_ITERATIONS);
    expect(JSON.stringify(sealed)).not.toContain("sensitive-session-key");
    await expect(
      openVault(sealed, "correct horse battery staple"),
    ).resolves.toEqual(payload);
  });

  it("rejects weak or incorrect passwords", async () => {
    await expect(sealVault(payload, "too-short")).rejects.toThrow(
      /12 characters/,
    );
    const sealed = await sealVault(payload, "correct horse battery staple");
    await expect(
      openVault(sealed, "different password value"),
    ).rejects.toThrow();
  });
});
