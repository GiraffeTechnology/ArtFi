import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArguments, OFFICIAL } from "./mysql-legacy-adoption.mjs";
test("bounded first-ten official checksums and explicit command approvals", () => {
  assert.equal(OFFICIAL.length, 10);
  assert.equal(new Set(OFFICIAL.map((row) => row.checksum)).size, 10);
  for (const args of [
    ["apply"],
    ["inspect", "--password", "secret"],
    ["backup", "--defaults-file", "/p", "--database", "bad;SQL"],
    ["help", "--unknown", "value"],
  ])
    assert.throws(() => parseArguments(args));
  const approved = [
    "apply",
    "--defaults-file",
    "/p",
    "--database",
    "fixture",
    "--migrations",
    "/m",
    "--plan",
    "/p.json",
    "--plan-sha256",
    "0".repeat(64),
    "--backup",
    "/backup",
    "--approve-ledger-only",
    "--maintenance-confirmed",
  ];
  assert.equal(parseArguments(approved).options["approve-ledger-only"], true);
  assert.throws(() => parseArguments(approved.slice(0, -1)));
  assert.throws(() => parseArguments([...approved, "--lock-timeout", "301"]));
  assert.equal(
    parseArguments([...approved, "--lock-timeout", "0"]).options[
      "lock-timeout"
    ],
    "0",
  );
});
