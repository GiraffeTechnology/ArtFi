const encoder = new TextEncoder();
const decoder = new TextDecoder();
const context = encoder.encode("artfi-wallet-metadata-v1");

export const VAULT_ITERATIONS = 600_000;

export interface AccountDescriptor {
  address: `0x${string}`;
  connector: "hardware" | "walletconnect";
  label: string;
}

export interface WalletConnectSession {
  topic: string;
  relayUrl: string;
  sessionKey: string;
  expiresAt: number;
}

export interface VaultPayload {
  accounts: AccountDescriptor[];
  sessions: WalletConnectSession[];
  revision: number;
}

export interface EncryptedVault {
  version: 1;
  algorithm: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  cryptoApi: Crypto,
): Promise<CryptoKey> {
  if (password.length < 12)
    throw new Error("vault password must contain at least 12 characters");
  const material = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return cryptoApi.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: VAULT_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealVault(
  payload: VaultPayload,
  password: string,
  cryptoApi: Crypto = crypto,
): Promise<EncryptedVault> {
  const salt = cryptoApi.getRandomValues(new Uint8Array(16));
  const iv = cryptoApi.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, cryptoApi);
  const ciphertext = await cryptoApi.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: context, tagLength: 128 },
    key,
    encoder.encode(JSON.stringify(payload)),
  );
  return {
    version: 1,
    algorithm: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: VAULT_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    createdAt: new Date().toISOString(),
  };
}

export async function openVault(
  record: EncryptedVault,
  password: string,
  cryptoApi: Crypto = crypto,
): Promise<VaultPayload> {
  if (
    record.version !== 1 ||
    record.iterations !== VAULT_ITERATIONS ||
    record.algorithm !== "AES-GCM"
  ) {
    throw new Error("unsupported encrypted vault format");
  }
  const key = await deriveKey(password, base64ToBytes(record.salt), cryptoApi);
  const plaintext = await cryptoApi.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(record.iv),
      additionalData: context,
      tagLength: 128,
    },
    key,
    base64ToBytes(record.ciphertext),
  );
  const payload = JSON.parse(decoder.decode(plaintext)) as VaultPayload;
  if (
    !Array.isArray(payload.accounts) ||
    !Array.isArray(payload.sessions) ||
    !Number.isInteger(payload.revision)
  ) {
    throw new Error("invalid encrypted vault payload");
  }
  return payload;
}
