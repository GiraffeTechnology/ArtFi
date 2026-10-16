import test from "node:test";
import assert from "node:assert/strict";
import { createActionService } from "./action-service.mjs";
import { createActionStore } from "./action-store.mjs";
const mode = "TEST_ONLY_NO_REAL_VALUE",
  id = "TEST_ONLY_history";
const address = "0x" + "a".repeat(40);
const session = () => ({
  authenticated: true,
  wallet: address,
  chainId: "560048",
  expiresAt: 2000,
});
function fixture({
  storedWallet = address,
  chainId = "560048",
  missing = false,
  expireAt = null,
  events = [],
} = {}) {
  let now = 1000;
  const calls = [];
  const service = createActionService({
    policy: { mode },
    ethers: { isAddress: (value) => /^0x[0-9a-fA-F]{40}$/.test(value) },
    clock: () => now,
    store: {
      mode,
      async get(operationId) {
        calls.push(["get", operationId]);
        if (expireAt === "get") now = 2000;
        return missing
          ? null
          : {
              envelope: { intent: { wallet: storedWallet } },
              plan: { chainId },
            };
      },
      async history(operationId, page) {
        calls.push(["history", operationId, page]);
        if (expireAt === "history") now = 2000;
        return events;
      },
    },
  });
  return { service, calls };
}
test("read ownership binds the authenticated wallet and stored chain before accessing events", async () => {
  for (const options of [
    { storedWallet: "0x" + "b".repeat(40) },
    { chainId: "1" },
    { missing: true },
  ]) {
    const { service, calls } = fixture(options);
    await assert.rejects(
      service.actionHistory(session(), id),
      /OPERATION_NOT_FOUND/,
    );
    assert.equal(
      calls.some((call) => call[0] === "history"),
      false,
    );
  }
});
test("expired sessions at entry and after awaited reads cannot return history", async () => {
  const before = fixture();
  await assert.rejects(
    before.service.actionHistory({ ...session(), expiresAt: 1000 }, id),
    /AUTHENTICATED_SESSION_REQUIRED/,
  );
  assert.deepEqual(before.calls, []);
  for (const expireAt of ["get", "history"]) {
    const { service, calls } = fixture({ expireAt });
    await assert.rejects(
      service.actionHistory(session(), id),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
    assert.equal(
      calls.some((call) => call[0] === "history"),
      expireAt === "history",
    );
  }
});
test("canonical page descriptors reach storage and bind response cursors including an empty page", async () => {
  const page = { after: "9007199254740992", limit: 1 };
  const { service, calls } = fixture({
    events: [{ id: "9007199254740993", state: "PLANNED" }],
  });
  const result = await service.actionHistory(session(), id, page);
  assert.deepEqual(calls.at(-1), ["history", id, page]);
  assert.deepEqual(result.page, { version: 1, ...page });
  assert.equal(result.nextAfter, "9007199254740993");
  const empty = await fixture().service.actionHistory(session(), id, page);
  assert.equal(empty.nextAfter, page.after);
  assert.deepEqual(empty.events, []);
  const invalid = fixture();
  await assert.rejects(
    invalid.service.actionHistory(session(), id, { after: "01" }),
    /AUDIT_PAGE_INVALID/,
  );
  assert.deepEqual(invalid.calls, []);
});
function poolFixture(rows) {
  const calls = [];
  const connection = {
    async beginTransaction() {
      calls.push(["begin"]);
    },
    async execute(sql, parameters) {
      calls.push(["query", sql, parameters]);
      return [rows];
    },
    async commit() {
      calls.push(["commit"]);
    },
    async rollback() {
      calls.push(["rollback"]);
    },
    release() {
      calls.push(["release"]);
    },
    destroy() {
      calls.push(["destroy"]);
    },
  };
  return {
    calls,
    pool: {
      async getConnection() {
        calls.push(["acquire"]);
        return connection;
      },
    },
  };
}
test("storage uses a bounded exclusive SQL cursor and keeps uint64 precision", async () => {
  const f = poolFixture([
    {
      event_id: "18446744073709551615",
      operation_id: id,
      operation_version: "1",
      observed_at_ms: "1000",
      event_json: JSON.stringify({ mode, state: "PLANNED" }),
    },
  ]);
  const store = createActionStore({ mode, pool: f.pool });
  const events = await store.history(id, {
    after: "18446744073709551614",
    limit: 1,
  });
  const query = f.calls.find((call) => call[0] === "query");
  assert.match(
    query[1],
    /WHERE operation_id=\? AND event_id>\? ORDER BY event_id ASC LIMIT \?$/,
  );
  assert.deepEqual(query[2], [id, "18446744073709551614", 1]);
  assert.equal(events[0].id, "18446744073709551615");
  assert.deepEqual(
    f.calls.map((call) => call[0]),
    ["acquire", "begin", "query", "commit", "release"],
  );
});
test("storage rejects corrupt rows with a rollback and never issues workflow mutations", async () => {
  const f = poolFixture([{ event_id: "1", operation_id: "OTHER" }]);
  const store = createActionStore({ mode, pool: f.pool });
  await assert.rejects(store.history(id), /AUDIT_RECORD_INVALID/);
  assert.deepEqual(
    f.calls.map((call) => call[0]),
    ["acquire", "begin", "query", "rollback", "release"],
  );
  const before = f.calls.length;
  await assert.rejects(
    store.history(id, { after: "18446744073709551616" }),
    /AUDIT_PAGE_INVALID/,
  );
  assert.equal(f.calls.length, before);
  assert.equal(
    f.calls
      .filter((call) => call[0] === "query")
      .every((call) => /^SELECT /.test(call[1])),
    true,
  );
});
