import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loopbackURL,
  mapLimited,
  requestBudget,
  summary,
} from "./performance-common.mjs";

test("percentiles use nearest rank and report missing samples truthfully", () => {
  const result = summary(Array.from({ length: 100 }, (_, i) => 100 - i));
  assert.equal(result.p95Ms, 95);
  assert.equal(result.p99Ms, 99);
  assert.equal(result.meanMs, 50.5);
  assert.equal(summary([]).p95Ms, null);
});
test("performance targets are local-only", () => {
  assert.equal(loopbackURL("http://127.0.0.1:12345").hostname, "127.0.0.1");
  for (const url of [
    "https://example.com",
    "http://localhost:8545",
    "http://127.0.0.1.example.com",
    "http://user@127.0.0.1",
  ])
    assert.throws(() => loopbackURL(url));
});
test("bounded setup preserves every result", async () => {
  const results = await mapLimited([1, 2, 3, 4, 5], 2, async (n) => n * 2);
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
});
test("shared request cap never allows excess starts", () => {
  const budget = requestBudget({ limit: 100 });
  assert.equal(
    Array.from({ length: 125 }, () => budget.take()).filter(Boolean).length,
    100,
  );
  assert.equal(budget.issued, 100);
  assert.equal(budget.stopReason, "request-cap");
});
test("duration deadline ends new starts without inventing a cap pass", () => {
  let time = 10;
  const budget = requestBudget({
    limit: 90000,
    durationMs: 30000,
    now: () => time,
  });
  assert.equal(budget.take(), true);
  time = 30009;
  assert.equal(budget.take(), true);
  time = 30010;
  assert.equal(budget.take(), false);
  assert.equal(budget.stopReason, "duration");
  assert.equal(budget.issued, 2);
});
test("invalid request budgets fail before traffic", () => {
  for (const limit of [0, -1, NaN, Infinity, 1.5])
    assert.throws(() => requestBudget({ limit }));
  assert.throws(() => requestBudget({ limit: 10, durationMs: -1 }));
});
