import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
const source = "0x" + "3".repeat(40);
const base = {
  PATH: process.env.PATH,
  ARTFI_SOURCE_AUTHORITY: source,
  ARTFI_RWA_TEST_ONLY: "true",
  ARTFI_ADMIN: "0x" + "1".repeat(40),
  ARTFI_REGISTRAR: "0x" + "2".repeat(40),
};
function check(env = {}) {
  return spawnSync(
    "bash",
    ["-eu", "-c", "source scripts/lib/require-rwa-source-config.sh"],
    { env: { ...base, ...env }, encoding: "utf8" },
  );
}
test("guarded source deployment validates public inputs before network or broadcast", () => {
  assert.equal(check().status, 0);
  for (const patch of [
    { ARTFI_SOURCE_AUTHORITY: "" },
    { ARTFI_SOURCE_AUTHORITY: "0x" + "0".repeat(40) },
    { ARTFI_SOURCE_AUTHORITY: "not-an-address" },
    { ARTFI_RWA_TEST_ONLY: "" },
    { ARTFI_RWA_TEST_ONLY: "maybe" },
    { ARTFI_ADMIN: source },
    { ARTFI_REGISTRAR: source },
  ])
    assert.notEqual(check(patch).status, 0);
  assert.equal(check({ ARTFI_RWA_TEST_ONLY: "false" }).status, 0);
  assert.equal(check({ ARTFI_ADMIN: "", ARTFI_REGISTRAR: "" }).status, 0);
});
