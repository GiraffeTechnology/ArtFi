import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAgentHTTPServer } from "../src/transport.mjs";
const mode = "TEST_ONLY_NO_REAL_VALUE",
  id = "TEST_ONLY_history";
async function withServer(body, { authorized = true } = {}) {
  const calls = [],
    session = { id: "TEST_ONLY_session" };
  const service = {
    async actionHistory(actual, operationId, page) {
      assert.equal(actual, session);
      calls.push(["history", operationId, page]);
      return {
        id: operationId,
        mode,
        events: [],
        nextAfter: page.after,
        page: { version: 1, ...page },
      };
    },
    async getAction(actual, operationId) {
      assert.equal(actual, session);
      calls.push(["get", operationId]);
      return { id: operationId, mode, state: "PLANNED" };
    },
    async createAction() {
      assert.fail("read route must not create an action");
    },
    async recordRevocation() {
      assert.fail("read route must not write revocation");
    },
  };
  const server = createAgentHTTPServer({
    async authenticate() {
      if (!authorized) throw Error("AGENT_TRANSPORT_UNAUTHORIZED");
      return session;
    },
    getRuntimeStatus: () => ({ mode, state: "TEST_ONLY" }),
    getService: () => service,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = "http://127.0.0.1:" + server.address().port;
  try {
    await body({ root, calls });
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeIdleConnections();
    await closed;
  }
}
test("workflow history GET accepts canonical cursor pages and retains private response headers", async () => {
  await withServer(async ({ root, calls }) => {
    const response = await fetch(
      root +
        "/v1/agent/actions/" +
        id +
        "/history?after=9007199254740993&limit=2",
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const body = await response.json();
    assert.deepEqual(calls, [
      ["history", id, { after: "9007199254740993", limit: 2 }],
    ]);
    assert.deepEqual(body.page, {
      version: 1,
      after: "9007199254740993",
      limit: 2,
    });
    assert.equal(body.nextAfter, "9007199254740993");
  });
});
test("no-query history keeps the existing first-100 default and ordinary action reads remain available", async () => {
  await withServer(async ({ root, calls }) => {
    const history = await fetch(root + "/v1/agent/actions/" + id + "/history");
    assert.equal(history.status, 200);
    await history.json();
    const action = await fetch(root + "/v1/agent/actions/" + id);
    assert.equal(action.status, 200);
    await action.json();
    assert.deepEqual(calls, [
      ["history", id, { after: "0", limit: 100 }],
      ["get", id],
    ]);
    const unsupported = await fetch(
      root + "/v1/agent/actions/" + id + "?after=1",
    );
    assert.equal(unsupported.status, 404);
    await unsupported.json();
    assert.equal(calls.length, 2);
  });
});
test("invalid history query parameters are refused before any workflow history call", async () => {
  await withServer(async ({ root, calls }) => {
    for (const query of [
      "after=01",
      "after=18446744073709551616",
      "limit=0",
      "limit=101",
      "limit=01",
      "after=1&after=2",
      "limit=1&limit=1",
      "wallet=other",
    ]) {
      const response = await fetch(
        root + "/v1/agent/actions/" + id + "/history?" + query,
      );
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).code, "AUDIT_PAGE_INVALID", query);
    }
    assert.deepEqual(calls, []);
  });
});
test("unauthenticated history reads cannot reach the service", async () => {
  await withServer(
    async ({ root, calls }) => {
      const response = await fetch(
        root + "/v1/agent/actions/" + id + "/history?after=0",
      );
      assert.equal(response.status, 401);
      assert.equal(
        (await response.json()).code,
        "AGENT_TRANSPORT_UNAUTHORIZED",
      );
      assert.deepEqual(calls, []);
    },
    { authorized: false },
  );
});
