import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findSecretPatterns,
  isSignedEvmTransactionHex,
} from "./secret-patterns.mjs";

// Construct inert serialization shapes, never sign, recover a key or contact a chain.
// No complete raw transaction is committed as a string fixture.
const empty = Buffer.alloc(0);
const integer = (n) => {
  if (BigInt(n) === 0n) return empty;
  let hex = BigInt(n).toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex");
};
function rlp(value) {
  const list = Array.isArray(value);
  const payload = list ? Buffer.concat(value.map(rlp)) : value;
  if (!list && payload.length === 1 && payload[0] < 128) return payload;
  const base = list ? 192 : 128;
  if (payload.length < 56)
    return Buffer.concat([Buffer.from([base + payload.length]), payload]);
  const length = integer(payload.length);
  return Buffer.concat([
    Buffer.from([base + 55 + length.length]),
    length,
    payload,
  ]);
}
function fields(type) {
  const to = Buffer.alloc(20, 17);
  if (type === 0)
    return [
      empty,
      integer(1),
      integer(21000),
      to,
      empty,
      empty,
      integer(27),
      integer(1),
      integer(2),
    ];
  if (type === 1)
    return [
      integer(560048),
      empty,
      integer(1),
      integer(21000),
      to,
      empty,
      empty,
      [],
      empty,
      integer(1),
      integer(2),
    ];
  const common = [
    integer(560048),
    empty,
    integer(1),
    integer(2),
    integer(21000),
    to,
    empty,
    empty,
    [],
  ];
  if (type === 3) common.push(integer(1), [Buffer.alloc(32, 1)]);
  if (type === 4)
    common.push([[integer(560048), to, empty, empty, integer(1), integer(2)]]);
  return [...common, empty, integer(1), integer(2)];
}
function serialized(type, body = fields(type)) {
  const prefix = type === 0 ? empty : Buffer.from([type]);
  return "0x" + Buffer.concat([prefix, rlp(body)]).toString("hex");
}
for (const type of [0, 1, 2, 3, 4]) {
  test("finds signed-envelope structure for transaction type " + type, () => {
    const value = serialized(type);
    assert.equal(isSignedEvmTransactionHex(value), true);
    assert.deepEqual(findSecretPatterns(JSON.stringify({ payload: value })), [
      "raw signed EVM transaction envelope",
    ]);
    assert.deepEqual(findSecretPatterns("[" + value.toUpperCase() + "]"), [
      "raw signed EVM transaction envelope",
    ]);
    assert.deepEqual(findSecretPatterns(value.slice(2)), [
      "raw signed EVM transaction envelope",
    ]);
  });
}
test("recognizes full-file binary envelopes without mislabeling arbitrary binary assets", () => {
  const value = Buffer.from(serialized(4).slice(2), "hex");
  assert.deepEqual(findSecretPatterns(value), [
    "raw signed EVM transaction envelope",
  ]);
  assert.deepEqual(
    findSecretPatterns(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    [],
  );
});
test("recognizes protected legacy v and contract creation", () => {
  const f = fields(0);
  f[3] = empty;
  f[6] = integer(560048n * 2n + 35n);
  assert.equal(isSignedEvmTransactionHex(serialized(0, f)), true);
  const typed = fields(2);
  typed[5] = empty;
  assert.equal(isSignedEvmTransactionHex(serialized(2, typed)), true);
});
test("checks access lists and preserves data containing nested-looking bytes", () => {
  const f = fields(2);
  f[7] = Buffer.alloc(300, 192);
  f[8] = [[Buffer.alloc(20, 17), [Buffer.alloc(32, 34), Buffer.alloc(32, 34)]]];
  assert.equal(isSignedEvmTransactionHex(serialized(2, f)), true);
  f[8][0][1][0] = Buffer.alloc(31, 34);
  assert.equal(isSignedEvmTransactionHex(serialized(2, f)), false);
});
test("detects signed inner blob payload in old and versioned pool wrappers", () => {
  const payload = fields(3);
  // Blob validity is irrelevant to whether the inner signature has leaked.
  assert.equal(
    isSignedEvmTransactionHex(serialized(3, [payload, [], [], []])),
    true,
  );
  assert.equal(
    isSignedEvmTransactionHex(serialized(3, [payload, integer(1), [], [], []])),
    true,
  );
});
test("does not mistake unsigned preimages or zero signatures for signed envelopes", () => {
  for (const type of [0, 1, 2, 3, 4]) {
    const f = fields(type);
    assert.equal(
      isSignedEvmTransactionHex(serialized(type, f.slice(0, -3))),
      false,
    );
    f[f.length - 2] = empty;
    assert.equal(isSignedEvmTransactionHex(serialized(type, f)), false);
  }
  const eip155Preimage = [
    ...fields(0).slice(0, 6),
    integer(560048),
    empty,
    empty,
  ];
  assert.equal(isSignedEvmTransactionHex(serialized(0, eip155Preimage)), false);
});
test("excludes hashes, signatures, addresses, ABI calldata and unknown types", () => {
  const candidates = [
    "0x" + "ab".repeat(32),
    "0x" + "ab".repeat(65),
    "0x" + "ab".repeat(20),
    "0x" + "ab".repeat(4) + "00".repeat(64),
    "0x05" + rlp(fields(2)).toString("hex"),
  ];
  for (const value of candidates)
    assert.equal(isSignedEvmTransactionHex(value), false);
  assert.deepEqual(findSecretPatterns(candidates.join("\n")), []);
});
test("rejects malformed boundaries, noncanonical RLP and trailing bytes", () => {
  const value = serialized(2);
  const body = rlp(fields(2));
  assert.equal(isSignedEvmTransactionHex(value.slice(0, -2)), false);
  assert.equal(isSignedEvmTransactionHex(value + "00"), false);
  assert.equal(isSignedEvmTransactionHex(value + "f"), false);
  assert.equal(
    isSignedEvmTransactionHex(
      "0x02f900" +
        body.length.toString(16).padStart(2, "0") +
        body.subarray(2).toString("hex"),
    ),
    false,
  );
  assert.equal(isSignedEvmTransactionHex("0x02f8"), false);
  assert.equal(isSignedEvmTransactionHex("0x02bfffffffffffffffff"), false);
  assert.deepEqual(findSecretPatterns("identifier" + value + "Suffix"), []);
});
test("refuses integer leading zeros, invalid parity and wrong field kinds", () => {
  const f = fields(2);
  f[1] = Buffer.from([0, 1]);
  assert.equal(isSignedEvmTransactionHex(serialized(2, f)), false);
  f[1] = empty;
  f[9] = integer(2);
  assert.equal(isSignedEvmTransactionHex(serialized(2, f)), false);
  f[9] = empty;
  f[5] = [];
  assert.equal(isSignedEvmTransactionHex(serialized(2, f)), false);
  const legacy = fields(0);
  legacy[6] = integer(1);
  assert.equal(isSignedEvmTransactionHex(serialized(0, legacy)), false);
});
test("keeps delegated-authorization and blob fields distinct from outer signature", () => {
  const delegated = fields(4);
  delegated[9] = [];
  assert.equal(isSignedEvmTransactionHex(serialized(4, delegated)), false);
  delegated[9] = [[empty, Buffer.alloc(20), empty, integer(2), empty, empty]];
  assert.equal(isSignedEvmTransactionHex(serialized(4, delegated)), true);
  delegated[5] = empty;
  assert.equal(isSignedEvmTransactionHex(serialized(4, delegated)), false);
  const blob = fields(3);
  blob[10] = [];
  assert.equal(isSignedEvmTransactionHex(serialized(3, blob)), false);
});
test("retains existing secret and IPv4 rules without returning matched values", () => {
  const values = [
    [["-----BEGIN ", "EC ", "PRIVATE KEY-----"].join(""), "private key block"],
    ["AK" + "IA" + "A".repeat(16), "AWS access key"],
    ["gh" + "p_" + "a".repeat(36), "GitHub token"],
    ["PRIVATE" + "_KEY=0x" + "ab".repeat(32), "raw EVM private key assignment"],
    [
      "MNEMONIC='" + Array(12).fill("synthetic").join(" ") + "'",
      "mnemonic assignment",
    ],
    [[192, 0, 2, 1].join("."), "plaintext server IPv4 address"],
  ];
  for (const [value, rule] of values)
    assert.deepEqual(findSecretPatterns(value), [rule]);
  assert.deepEqual(
    findSecretPatterns(["127.0.0.1", "0.0.0.0", "999.999.999.999"].join(" ")),
    [],
  );
  const value = serialized(2);
  const result = JSON.stringify(findSecretPatterns(value + " " + value));
  assert.equal(result.includes(value), false);
  assert.equal(JSON.parse(result).length, 1);
});
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), "artfi-secret-patterns-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd, stdio: "ignore" });
  mkdirSync(join(cwd, "scripts/security"), { recursive: true });
  for (const file of ["check-secrets.mjs", "secret-patterns.mjs"]) {
    copyFileSync(
      fileURLToPath(new URL(file, import.meta.url)),
      join(cwd, "scripts/security", file),
    );
  }
  return cwd;
}
test("existing CLI fails closed on a raw envelope without printing its bytes", (t) => {
  const cwd = repository(t);
  const value = serialized(2);
  const name = "candidate\nnote.txt";
  writeFileSync(join(cwd, name), value);
  writeFileSync(
    join(cwd, "signed-envelope.bin"),
    Buffer.from(serialized(4).slice(2), "hex"),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/security/check-secrets.mjs"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.includes(
      JSON.stringify(name) + ": raw signed EVM transaction envelope",
    ),
    true,
  );
  assert.equal(
    result.stderr.includes(
      '"signed-envelope.bin": raw signed EVM transaction envelope',
    ),
    true,
  );
  assert.equal(result.stderr.includes(value), false);
  assert.equal(result.stdout.includes(value), false);
});
test("existing CLI retains ignored-file and lockfile scope", (t) => {
  const cwd = repository(t);
  writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(cwd, "ignored.txt"), serialized(1));
  writeFileSync(join(cwd, "pnpm-lock.yaml"), serialized(2));
  writeFileSync(join(cwd, "public.txt"), "0x" + "ab".repeat(32));
  const result = spawnSync(
    process.execPath,
    ["scripts/security/check-secrets.mjs"],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Secret pattern check passed/);
});
