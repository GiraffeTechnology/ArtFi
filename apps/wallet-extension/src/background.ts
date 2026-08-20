import {
  openVault,
  sealVault,
  type EncryptedVault,
  type VaultPayload,
} from "./vault.js";

const vaultKey = "artfiEncryptedVault";
let unlockedPayload: VaultPayload | null = null;

type WalletMessage =
  | { type: "vault.status" }
  | { type: "vault.create"; password: string; payload: VaultPayload }
  | { type: "vault.unlock"; password: string }
  | { type: "vault.lock" };

async function handleMessage(message: WalletMessage): Promise<unknown> {
  if (message.type === "vault.status") {
    const local = await chrome.storage.local.get(vaultKey);
    return {
      configured: Boolean(local[vaultKey]),
      locked: unlockedPayload === null,
    };
  }
  if (message.type === "vault.create") {
    const encrypted = await sealVault(message.payload, message.password);
    await chrome.storage.local.set({ [vaultKey]: encrypted });
    unlockedPayload = null;
    return { configured: true, locked: true };
  }
  if (message.type === "vault.unlock") {
    const stored = await chrome.storage.local.get(vaultKey);
    const encrypted = stored[vaultKey] as EncryptedVault | undefined;
    if (!encrypted) throw new Error("encrypted vault is not configured");
    const payload = await openVault(encrypted, message.password);
    unlockedPayload = payload;
    return { configured: true, locked: false, accounts: payload.accounts };
  }
  unlockedPayload = null;
  return { configured: true, locked: true };
}

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse) => {
    void handleMessage(message as WalletMessage)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "wallet error",
        }),
      );
    return true;
  },
);
