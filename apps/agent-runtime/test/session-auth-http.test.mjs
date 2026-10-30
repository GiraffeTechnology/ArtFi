import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createSessionAuthenticator } from "../src/auth.mjs";
import { createAgentHTTPServer } from "../src/transport.mjs";
import { readRequestJSON } from "../src/http-json.mjs";
const agentToken = "TEST_ONLY_agent_bridge_" + "a".repeat(32),
  userToken = "TEST_ONLY_user_bridge_" + "b".repeat(32),
  access = "TEST_ONLY_user_access_" + "c".repeat(32),
  origin = "https://artfi.example";
const mode = "TEST_ONLY_NO_REAL_VALUE";
const activeSession = () => ({
  id: "TEST_ONLY_session",
  address: "0x" + "1".repeat(40),
  chainId: 560048,
  expiresAt: 4000,
  accessExpiresAt: 3000,
});
async function listening(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}
async function stop(server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}
async function withAuthenticatedServer(body) {
  const apiCalls = [],
    businessCalls = [],
    state = { status: 200, kind: "json", session: activeSession() };
  const api = createServer(async (req, res) => {
    try {
      assert.equal(req.url, "/auth-proxy/v1/user/auth/session");
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, `Bearer ${userToken}`);
      assert.deepEqual(await readRequestJSON(req), { accessToken: access });
      apiCalls.push({ verifiedBridge: true, verifiedAccess: true });
      res.writeHead(state.status, {
        "content-type":
          state.kind === "wrong-mime" ? "text/html" : "application/json",
      });
      if (state.kind === "stalled") {
        res.write('{"session":');
        return;
      }
      if (state.kind === "invalid-utf8") {
        res.end(Buffer.from([255]));
        return;
      }
      if (state.kind === "invalid-json") {
        res.end("PRIVATE_UNREADABLE_RESPONSE");
        return;
      }
      if (state.kind === "oversized") {
        res.end(JSON.stringify({ padding: "x".repeat(16385) }));
        return;
      }
      res.end(
        JSON.stringify({
          session: state.session,
          PRIVATE_UPSTREAM_DETAIL: "not forwarded",
        }),
      );
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"code":"TEST_FIXTURE_ERROR"}');
    }
  });
  const apiRoot = await listening(api);
  const agent = createAgentHTTPServer({
    authenticate: createSessionAuthenticator({
      apiURL: apiRoot + "/auth-proxy",
      userAuthBridgeToken: userToken,
      agentBridgeToken: agentToken,
      webOrigin: origin,
      clock: () => 1000,
    }),
    clock: () => 1000,
    getRuntimeStatus: () => ({ mode, state: "TEST_ONLY" }),
    getService: () => ({
      async actionHistory(session, id, page) {
        businessCalls.push(structuredClone(session));
        return { id, page, mode, events: [] };
      },
      async createAction() {
        assert.fail("Authentication read tests cannot create actions");
      },
      async execute() {
        assert.fail("Authentication read tests cannot execute");
      },
    }),
  });
  const root = await listening(agent);
  const headers = {
    authorization: `Bearer ${agentToken}`,
    "x-artfi-web-origin": origin,
    "x-artfi-user-access": access,
  };
  const read = (patch = {}) =>
    fetch(root + "/v1/agent/actions/TEST_ONLY_auth/history?after=0&limit=1", {
      headers: { ...headers, ...patch },
    });
  try {
    await body({ read, state, apiCalls, businessCalls });
  } finally {
    await stop(agent);
    await stop(api);
  }
}
test("actual Agent session bridge forwards only expected credentials and projects a current principal", async () => {
  await withAuthenticatedServer(async ({ read, apiCalls, businessCalls }) => {
    const response = await read();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    const body = await response.json();
    assert.equal(body.id, "TEST_ONLY_auth");
    assert.equal(apiCalls.length, 1);
    assert.deepEqual(businessCalls, [
      {
        authenticated: true,
        id: "TEST_ONLY_session",
        wallet: activeSession().address,
        chainId: "560048",
        expiresAt: 3000,
      },
    ]);
    const serialized = JSON.stringify(body);
    for (const secret of [
      agentToken,
      userToken,
      access,
      "PRIVATE_UPSTREAM_DETAIL",
    ])
      assert.equal(serialized.includes(secret), false);
  });
});
test("actual Agent local bridge origin and access refusals stop before the session API", async () => {
  await withAuthenticatedServer(async ({ read, apiCalls, businessCalls }) => {
    for (const [patch, status] of [
      [{ authorization: "Bearer TEST_ONLY_WRONG" }, 401],
      [{ "x-artfi-web-origin": "https://other.example" }, 403],
      [{ "x-artfi-user-access": "short" }, 401],
      [{ "x-artfi-user-access": "" }, 401],
    ]) {
      const response = await read(patch);
      assert.equal(response.status, status);
      await response.json();
    }
    assert.equal(apiCalls.length, 0);
    assert.equal(businessCalls.length, 0);
  });
});
test("actual Agent rejects expired foreign-chain and malformed authoritative session fields", async () => {
  await withAuthenticatedServer(async ({ read, state, businessCalls }) => {
    for (const patch of [
      { chainId: 1 },
      { expiresAt: 1000 },
      { accessExpiresAt: 1000 },
      { accessExpiresAt: 5000 },
      { address: "invalid" },
    ]) {
      state.session = { ...activeSession(), ...patch };
      const response = await read();
      assert.equal(response.status, 401);
      assert.equal(
        (await response.json()).code,
        "AUTHENTICATED_SESSION_REQUIRED",
      );
    }
    assert.equal(businessCalls.length, 0);
  });
});
test("actual Agent rechecks session authority on the next read after revocation", async () => {
  await withAuthenticatedServer(
    async ({ read, state, apiCalls, businessCalls }) => {
      const first = await read();
      assert.equal(first.status, 200);
      await first.json();
      state.status = 401;
      const second = await read();
      assert.equal(second.status, 401);
      assert.equal(
        (await second.json()).code,
        "AUTHENTICATED_SESSION_REQUIRED",
      );
      assert.equal(apiCalls.length, 2);
      assert.equal(businessCalls.length, 1);
    },
  );
});
test("actual session HTTP failures and malformed response bodies preserve safe authentication versus dependency codes", async () => {
  await withAuthenticatedServer(async ({ read, state, businessCalls }) => {
    for (const status of [400, 401, 403, 429, 500]) {
      state.status = status;
      const response = await read();
      assert.equal(
        response.status,
        [400, 401, 403].includes(status) ? 401 : 503,
      );
      assert.equal(
        (await response.json()).code,
        [400, 401, 403].includes(status)
          ? "AUTHENTICATED_SESSION_REQUIRED"
          : "SESSION_DEPENDENCY_UNAVAILABLE",
      );
    }
    state.status = 200;
    for (const kind of [
      "wrong-mime",
      "invalid-utf8",
      "invalid-json",
      "oversized",
    ]) {
      state.kind = kind;
      const response = await read();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        code: "SESSION_DEPENDENCY_UNAVAILABLE",
        mode,
      });
    }
    assert.equal(businessCalls.length, 0);
  });
});
test(
  "actual session body deadline refuses without entering the Agent business service or retrying",
  { timeout: 5000 },
  async () => {
    await withAuthenticatedServer(
      async ({ read, state, apiCalls, businessCalls }) => {
        state.kind = "stalled";
        const response = await read();
        assert.equal(response.status, 503);
        assert.equal(
          (await response.json()).code,
          "SESSION_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal(apiCalls.length, 1);
        assert.equal(businessCalls.length, 0);
      },
    );
  },
);
