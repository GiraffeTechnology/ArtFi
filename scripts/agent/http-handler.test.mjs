import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHttpHandler } from "./http-handler.mjs";

function fixture(overrides = {}) {
  const calls = [];
  const service = {
    async prepareIntent(session, input) {
      calls.push(["prepare", session, input]);
      return { mode: "TEST_ONLY_NO_REAL_VALUE", operationId: "operation-1" };
    },
    async createIntent(session, input) {
      calls.push(["create", session, input]);
      return { id: "operation-1", state: "PREPARED", existing: false };
    },
    async getIntent(session, id) {
      calls.push(["get", session, id]);
      return { id, mode: "TEST_ONLY_NO_REAL_VALUE" };
    },
    async recordRevocation(session, id, transactionHash) {
      calls.push(["revoke", session, id, transactionHash]);
      return { id, state: "PENDING" };
    },
    ...overrides,
  };
  return { calls, handle: createAgentHttpHandler({ service }) };
}

const session = Object.freeze({
  authenticated: true,
  wallet: "0x" + "ab".repeat(20),
  expiresAt: 1_800_000_000_000,
});
const post = (path, value) => ({
  method: "POST",
  path,
  contentType: "application/json",
  bodyText: JSON.stringify(value),
});
const value = (response) => JSON.parse(response.body);

test("handler passes the separate authenticated session to the exact prepare route", async () => {
  const f = fixture();
  const input = {
    contract: "0x" + "cd".repeat(20),
    tokenId: "1",
    maxUnitPrice: "2",
    validUntil: "1800000000",
  };
  const response = await f.handle(
    post("/intents/prepare", {
      ...input,
      session: { authenticated: true },
    }),
    session,
  );
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);

  const accepted = await f.handle(post("/intents/prepare", input), session);
  assert.equal(accepted.status, 200);
  assert.deepEqual(f.calls, [["prepare", session, input]]);
  assert.equal(accepted.headers["cache-control"], "no-store");
});

test("handler maps create, read, and revocation without moving session into JSON", async () => {
  const f = fixture();
  assert.equal(
    (await f.handle(post("/intents", { operationId: "operation-1" }), session))
      .status,
    200,
  );
  assert.equal(
    (await f.handle({ method: "GET", path: "/intents/operation-1" }, session))
      .status,
    200,
  );
  const transactionHash = "0x" + "12".repeat(32);
  assert.equal(
    (
      await f.handle(
        post("/intents/operation-1/revocation", { transactionHash }),
        session,
      )
    ).status,
    200,
  );
  assert.deepEqual(f.calls, [
    ["create", session, { operationId: "operation-1" }],
    ["get", session, "operation-1"],
    ["revoke", session, "operation-1", transactionHash],
  ]);
});

test("handler refuses malformed, oversized, and unknown requests without service access", async () => {
  const f = fixture();
  for (const request of [
    {
      method: "POST",
      path: "/intents",
      contentType: "text/plain",
      bodyText: "{}",
    },
    {
      method: "GET",
      path: "/intents/operation-1?expand=secret",
    },
    {
      method: "DELETE",
      path: "/intents/operation-1",
    },
  ]) {
    const response = await f.handle(request, session);
    assert.ok([400, 404].includes(response.status));
  }
  const small = createAgentHttpHandler({
    service: {
      prepareIntent: async () => {},
      createIntent: async () => {},
      getIntent: async () => {},
      recordRevocation: async () => {},
    },
    maxRequestBytes: 1024,
  });
  const oversized = await small(
    {
      method: "POST",
      path: "/intents",
      contentType: "application/json",
      bodyText: JSON.stringify({ value: "x".repeat(1024) }),
    },
    session,
  );
  assert.equal(oversized.status, 413);
  assert.equal(value(oversized).error, "REQUEST_TOO_LARGE");
  assert.equal(f.calls.length, 0);
});

test("handler maps authentication and unknown failures without exposing details", async () => {
  const auth = fixture({
    getIntent: async () => {
      throw Error("AUTHENTICATED_SESSION_REQUIRED");
    },
  });
  const denied = await auth.handle(
    { method: "GET", path: "/intents/operation-1" },
    session,
  );
  assert.equal(denied.status, 401);
  assert.deepEqual(value(denied), { error: "AUTHENTICATED_SESSION_REQUIRED" });

  const dependency = fixture({
    getIntent: async () => {
      throw Error("database host and password must not leak");
    },
  });
  const unavailable = await dependency.handle(
    { method: "GET", path: "/intents/operation-1" },
    session,
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(value(unavailable), { error: "DEPENDENCY_UNAVAILABLE" });

  const invalid = fixture({ getIntent: async () => undefined });
  const invalidResponse = await invalid.handle(
    { method: "GET", path: "/intents/operation-1" },
    session,
  );
  assert.equal(invalidResponse.status, 502);
  assert.deepEqual(value(invalidResponse), {
    error: "HANDLER_RESPONSE_INVALID",
  });
});
