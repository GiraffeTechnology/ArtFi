import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTestAccount, runSelfTest } from "./test-wallet.mjs";

const testEnvironment = (keyPath, overrides = {}) => ({
  NODE_ENV: "test",
  ARTFI_ENV: "test",
  ARTFI_CHAIN_ID: "84532",
  ARTFI_TEST_PRIVATE_KEY_FILE: keyPath,
  ARTFI_TEST_WALLET_SKIP_PERMISSION_CHECK: "true",
  ...overrides,
});

function createKeyFile() {
  const directory = mkdtempSync(join(tmpdir(), "artfi-test-wallet-"));
  const keyPath = join(directory, "wallet.key");
  const key = `0x${randomBytes(32).toString("hex")}`;
  writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return { directory, keyPath, key };
}

test("loads a valid test account without exposing its private key", () => {
  const { keyPath, key } = createKeyFile();
  const account = loadTestAccount(testEnvironment(keyPath));
  assert.match(account.address, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(JSON.stringify(account).includes(key.slice(2)), false);
});

test("signs and verifies an offline domain-separated ownership message", async () => {
  const { keyPath } = createKeyFile();
  const result = await runSelfTest(testEnvironment(keyPath));
  assert.equal(result.verified, true);
});

test("rejects relative paths, mainnet, malformed values, and symlinks", (context) => {
  assert.throws(
    () => loadTestAccount(testEnvironment("wallet.key")),
    /absolute path/,
  );

  const { directory, keyPath } = createKeyFile();
  assert.throws(
    () => loadTestAccount(testEnvironment(keyPath, { ARTFI_CHAIN_ID: "1" })),
    /restricted to Base Sepolia/,
  );

  const invalidPath = join(directory, "invalid.key");
  writeFileSync(invalidPath, "not-a-private-key\n", { mode: 0o600 });
  assert.throws(
    () => loadTestAccount(testEnvironment(invalidPath)),
    /invalid format/,
  );

  const symlinkPath = join(directory, "linked.key");
  try {
    symlinkSync(keyPath, symlinkPath);
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      context.diagnostic(
        "symlink assertion skipped: Windows developer mode is disabled",
      );
      return;
    }
    throw error;
  }
  assert.throws(
    () => loadTestAccount(testEnvironment(symlinkPath)),
    /non-symlinked/,
  );
});
