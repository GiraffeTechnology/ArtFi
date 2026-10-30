import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeObservation,
  createObservationReader,
  compareCurrentObservations,
} from "./observations.mjs";
import {
  rankApprovedProviders,
  createProviderRecovery,
} from "./provider-recovery.mjs";
const source = { id: "SOURCE_A", scopes: ["asset"], maxAgeMs: 100 };
const current = {
  sourceId: "SOURCE_A",
  scope: "asset",
  revision: "r1",
  observedAt: 900,
  status: "CURRENT",
  data: { active: true },
};
test("A1 attribution and freshness distinguish all observation states", () => {
  assert.equal(normalizeObservation(source, current, 1000).status, "CURRENT");
  assert.equal(normalizeObservation(source, current, 1001).status, "STALE");
  for (const status of ["UNAVAILABLE", "CONFLICTING", "UNVERIFIED"])
    assert.equal(
      normalizeObservation(source, { ...current, status }, 1000).status,
      status,
    );
  assert.equal(
    normalizeObservation(source, { ...current, sourceId: "SOURCE_B" }, 1000)
      .status,
    "UNVERIFIED",
  );
  assert.equal(
    normalizeObservation(source, { ...current, scope: "unapproved" }, 1000)
      .status,
    "UNVERIFIED",
  );
  assert.equal(
    normalizeObservation(source, { ...current, observedAt: 7000 }, 1000).status,
    "UNVERIFIED",
  );
});
test("source outage preserves timestamped last-known observation without claiming current", async () => {
  let available = true;
  const reader = createObservationReader({
    clock: () => 1000,
    timeoutMs: 10,
    sources: [
      {
        ...source,
        read: async () => {
          if (!available) throw Error("down");
          return current;
        },
      },
    ],
  });
  assert.equal((await reader.read({}))[0].status, "CURRENT");
  available = false;
  const result = (await reader.read({}))[0];
  assert.equal(result.status, "UNAVAILABLE");
  assert.equal(result.lastKnown.observedAt, 900);
});
test("A1 simultaneous current contradictory claims remain conflicting", () => {
  const observations = [
    normalizeObservation(source, current, 1000),
    normalizeObservation(
      { ...source, id: "SOURCE_B" },
      { ...current, sourceId: "SOURCE_B", data: { active: false } },
      1000,
    ),
  ];
  assert.equal(
    compareCurrentObservations(observations, "asset", (x) => x.active).status,
    "CONFLICTING",
  );
});
test("A7 failover and A8 ranking remain inside exact approved provider scope", async () => {
  const calls = [];
  const providers = [
    {
      id: "RPC_A",
      scopes: ["chain"],
      read: async () => {
        calls.push("RPC_A");
        throw Error("down");
      },
    },
    {
      id: "RPC_B",
      scopes: ["chain"],
      read: async () => {
        calls.push("RPC_B");
        return { status: "CURRENT", data: "test-only" };
      },
    },
    {
      id: "SOURCE_C",
      scopes: ["asset"],
      read: async () => {
        throw Error("wrong scope");
      },
    },
  ];
  const engine = createProviderRecovery({
    providers,
    scope: "chain",
    timeoutMs: 10,
  });
  assert.equal((await engine.read({})).providerId, "RPC_B");
  assert.deepEqual(calls, ["RPC_A", "RPC_B"]);
  calls.length = 0;
  assert.equal((await engine.read({})).providerId, "RPC_B");
  assert.deepEqual(calls, ["RPC_B"]);
  assert.equal(engine.snapshot().authorityModified, false);
  assert.deepEqual(
    rankApprovedProviders(
      providers,
      { INJECTED: { successes: 100000, failures: 0 } },
      "chain",
    ),
    ["RPC_A", "RPC_B"],
  );
});
test("every unavailable approved provider deterministically reaches SAFE_DEGRADED", async () => {
  const engine = createProviderRecovery({
    scope: "chain",
    timeoutMs: 10,
    providers: [
      {
        id: "RPC_A",
        scopes: ["chain"],
        read: async () => new Promise(() => {}),
      },
    ],
  });
  assert.equal((await engine.read({})).state, "SAFE_DEGRADED");
});
