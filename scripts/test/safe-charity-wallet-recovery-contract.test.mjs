import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (p) =>
  readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
test("charity safe recovery returns to the original wallet and rechecks the other owner's execution", () => {
  const source = read(
    "apps/web/src/components/charity-edition-create-flow.tsx",
  );
  assert.match(
    source,
    /`charity-series:\$\{chainId\}:\$\{address\?\.toLowerCase\(\)/,
  );
  assert.match(
    source,
    /value.walletAddress.toLowerCase\(\) === address.toLowerCase\(\)/,
  );
  assert.match(
    source,
    /!sameCharitySeriesFields\(record.data.fields, fields\)/,
  );
  const spec = read("apps/web/e2e-safe/admin-safe.spec.ts");
  const start = spec.indexOf('test("charity safe submission');
  const end = spec.indexOf("\ntest(", start + 5);
  assert.ok(start >= 0 && end > start);
  const flow = spec.slice(start, end);
  const markers = [
    "await switchOwner(page, state, a.otherWallet)",
    'name: "Revoke my confirmation"',
    "state.chain.state.now += 60n",
    'name: "Execute confirmed proposal"',
    "const executionHash =",
    "await switchOwner(page, state, a.wallet)",
    'name: "Refresh safe status"',
    "Execution transaction hash (any owner)",
    'name: "Check execution receipt"',
    'name: "Recover creation result"',
  ];
  let position = -1;
  for (const marker of markers) {
    const next = flow.indexOf(marker, position + 1);
    assert.ok(next > position, marker);
    position = next;
  }
  const boundary = flow.indexOf("await switchOwner(page, state, a.wallet)");
  assert.match(
    flow.slice(0, boundary),
    /name: "ERC-1155 series confirmed"[\s\S]*?\.toHaveCount\(0\)/,
  );
  assert.match(
    flow.slice(position),
    /name: "ERC-1155 series confirmed"[\s\S]*?\.toBeVisible\(\)/,
  );
  assert.match(flow, /expect\(call.args\?\.\[3\]\).toBe\(a.wallet\)/);
});
