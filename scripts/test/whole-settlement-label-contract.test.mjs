import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
test("whole and fraction receipt expectations retain their distinct product completion semantics", () => {
  const spec = read("apps/web/e2e-market/confirmed-settlement.spec.ts");
  const start = spec.indexOf(
    'for (const kind of ["whole", "fraction"] as const) {',
  );
  const end = spec.indexOf('\ntest("a reverted approval', start);
  assert.ok(start >= 0 && end > start);
  const flow = spec.slice(start, end);
  const labels = flow.match(/kind === "whole"\s*\? "([^"]+)"\s*: "([^"]+)"/);
  assert.ok(labels);
  for (const [index, component] of [
    [1, "whole-artwork-listing"],
    [2, "fraction-listing"],
  ]) {
    const source = read(`apps/web/src/components/${component}.tsx`);
    assert.equal(source.match(/filled: "([^"]+)"/)[1], labels[index]);
  }
  assert.equal(
    labels[1],
    "Legacy token transfer confirmed; registration not established",
  );
  assert.equal(labels[2], "Settled on chain");
  assert.equal(
    (flow.match(/getByText\(confirmedLabel, \{ exact: true \}\)/g) ?? [])
      .length,
    3,
  );
  assert.equal((flow.match(/\)\.toHaveCount\(\s*0,?\s*\)/g) ?? []).length, 4);
  assert.ok(
    flow.indexOf('state.fill = "success"') < flow.indexOf(").toBeVisible({"),
  );
  assert.match(
    flow,
    /This does not establish Oracle registration or release of previously frozen funds/,
  );
  assert.match(
    flow,
    /getByText\("Settled on chain", \{ exact: true \}\),?\s*\)\.toHaveCount\(0\)/,
  );
});
