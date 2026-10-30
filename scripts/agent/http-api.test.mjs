import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHttpApi } from "./http-api.mjs";

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

test("same-origin client binds the four console methods without authority headers", async () => {
  const calls = [];
  const replies = [
    {
      mode: "TEST_ONLY_NO_REAL_VALUE",
      operationId: "op-1",
      domain: {},
      intent: {},
      asset: {},
      sale: {},
    },
    { id: "op-1", state: "PREPARED", existing: false },
    { id: "op-1", mode: "TEST_ONLY_NO_REAL_VALUE" },
    { id: "op-1", state: "CONFIRMED" },
  ];
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return json(replies.shift());
    },
  });
  await api.prepareIntent({ contract: "test" });
  await api.createIntent({
    operationId: "op-1",
    signature: "private-to-request",
  });
  await api.getIntent("op-1");
  await api.recordRevocation("op-1", "0x" + "AB".repeat(32));

  assert.deepEqual(
    calls.map(({ url, init }) => [url, init.method]),
    [
      ["/api/agent/v1/intents/prepare", "POST"],
      ["/api/agent/v1/intents", "POST"],
      ["/api/agent/v1/intents/op-1", "GET"],
      ["/api/agent/v1/intents/op-1/revocation", "POST"],
    ],
  );
  for (const { init } of calls) {
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(Object.hasOwn(init.headers, "authorization"), false);
  }
  assert.equal(
    JSON.parse(calls[3].init.body).transactionHash,
    "0x" + "ab".repeat(32),
  );
});

test("client fails closed on unsafe endpoint configuration and malformed success", async () => {
  assert.throws(
    () =>
      createAgentHttpApi({
        basePath: "https://elsewhere.invalid/api",
        fetchImpl: async () => json({}),
      }),
    /HTTP_API_CONFIGURATION_INVALID/,
  );
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async () =>
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await assert.rejects(api.getIntent("op-1"), /HTTP_RESPONSE_INVALID/);
});

test("client rejects oversized request before transport", async () => {
  let calls = 0;
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async () => {
      calls++;
      return json({});
    },
  });
  await assert.rejects(
    api.prepareIntent({ value: "x".repeat(70 * 1024) }),
    /HTTP_REQUEST_TOO_LARGE/,
  );
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(
    api.prepareIntent(cyclic),
    /HTTP_REQUEST_SCHEMA_INVALID/,
  );
  assert.equal(calls, 0);
});

test("client maps authentication refusal without exposing response content", async () => {
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async () =>
      new Response("sensitive upstream detail", {
        status: 401,
        headers: { "content-type": "text/plain" },
      }),
  });
  await assert.rejects(api.getIntent("op-1"), (error) => {
    assert.equal(error.message, "AUTHENTICATED_SESSION_REQUIRED");
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
});

test("client bounds a hung authenticated request", async () => {
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    requestTimeoutMs: 10,
    fetchImpl: (_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(Error("transport aborted")),
          { once: true },
        );
      }),
  });
  await assert.rejects(api.getIntent("op-1"), /DEPENDENCY_TIMEOUT/);
});

test("zero revocation hash and invalid create identity are rejected before transport", async () => {
  let calls = 0;
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async () => {
      calls++;
      return json({});
    },
  });
  await assert.rejects(
    api.recordRevocation("op-1", "0x" + "00".repeat(32)),
    /REVOCATION_HASH_INVALID/,
  );
  for (const input of [{}, { operationId: "../op-1" }])
    await assert.rejects(
      api.createIntent(input),
      /HTTP_REQUEST_SCHEMA_INVALID/,
    );
  assert.equal(calls, 0);
});

test("create response cannot replace the immutable recovery operation ID", async () => {
  let calls = 0;
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async () => {
      calls++;
      return json({ id: "another-op", state: "PREPARED", existing: false });
    },
  });
  await assert.rejects(
    api.createIntent({ operationId: "op-1", signature: "synthetic" }),
    /HTTP_RESPONSE_INVALID/,
  );
  assert.equal(calls, 1); // Ambiguous create must not be retried by the client.
});

test("client rejects a transport-reported redirect without consuming its body", async () => {
  let bodyReads = 0;
  const api = createAgentHttpApi({
    basePath: "/api/agent/v1",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => {
        bodyReads++;
        return JSON.stringify({ id: "op-1", mode: "TEST_ONLY_NO_REAL_VALUE" });
      },
    }),
  });
  await assert.rejects(api.getIntent("op-1"), /HTTP_RESPONSE_INVALID/);
  assert.equal(bodyReads, 0);
});

for (const phase of ["fetch", "body"]) {
  test(
    `client refuses successful ${phase} completion after its deadline`,
    { timeout: 1000 },
    async () => {
      const value = { id: "op-1", mode: "TEST_ONLY_NO_REAL_VALUE" };
      const api = createAgentHttpApi({
        basePath: "/api/agent/v1",
        requestTimeoutMs: 10,
        fetchImpl: async (_url, { signal }) => {
          const afterAbort = (result) =>
            new Promise((resolve) => {
              if (signal.aborted) resolve(result);
              else
                signal.addEventListener("abort", () => resolve(result), {
                  once: true,
                });
            });
          if (phase === "fetch") return afterAbort(json(value));
          return {
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            text: () => afterAbort(JSON.stringify(value)),
          };
        },
      });
      await assert.rejects(api.getIntent("op-1"), /DEPENDENCY_TIMEOUT/);
    },
  );
}
