import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, MODE } from "../src/config.mjs";
import { createSessionAuthenticator } from "../src/auth.mjs";
import { createAgentHTTPServer } from "../src/transport.mjs";
import { unavailableCapabilities } from "../src/capabilities.mjs";
import { createRuntimeController } from "../src/composition.mjs";
const bridge = "ISOLATED_TEST_AGENT_BRIDGE_CREDENTIAL";
const userBridge = "ISOLATED_TEST_AUTH_BRIDGE_CREDENTIAL";
const access = "ISOLATED_TEST_USER_ACCESS_CREDENTIAL";
const wallet = "0x" + "a".repeat(40),
  origin = "http://127.0.0.1:3000";
const config = () => ({
  schemaVersion: 1,
  mode: MODE,
  listen: { host: "127.0.0.1", port: 3202 },
  webOrigin: origin,
  authentication: { apiURL: "http://127.0.0.1:8080/prefix" },
  database: null,
  adapter: { kind: "unavailable" },
  worker: { intervalMs: 100 },
});
const request = () => ({
  headers: {
    authorization: `Bearer ${bridge}`,
    "x-artfi-user-access": access,
    "x-artfi-web-origin": origin,
  },
});
const auth = (override = {}) =>
  createSessionAuthenticator({
    apiURL: config().authentication.apiURL,
    userAuthBridgeToken: userBridge,
    agentBridgeToken: bridge,
    webOrigin: origin,
    clock: () => 1000,
    fetchImpl: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:8080/prefix/v1/user/auth/session");
      assert.equal(options.headers.authorization, `Bearer ${userBridge}`);
      assert.deepEqual(JSON.parse(options.body), { accessToken: access });
      return Response.json({
        session: {
          id: "test-session",
          address: wallet,
          chainId: 560048,
          expiresAt: 4000,
          accessExpiresAt: 3000,
        },
      });
    },
    ...override,
  });

test("configuration is data only and never expands test-only execution", () => {
  assert.equal(validateConfig(config()).mode, MODE);
  for (const patch of [
    { mode: "PRODUCTION" },
    { dependencyModule: "/tmp/inject.mjs" },
    { listen: { host: "0.0.0.0", port: 3202 } },
    { adapter: { kind: "wallet-executor" } },
    {
      adapter: {
        kind: "artfi-isolated-test-v1",
        baseURL: "https://external.invalid",
        tokenFile: "test",
      },
    },
  ])
    assert.throws(() => validateConfig({ ...config(), ...patch }));
  const database = {
    host: "external.invalid",
    port: 3306,
    database: "artfi",
    user: "agent",
    passwordFile: "/private/password",
    tls: null,
  };
  assert.throws(
    () => validateConfig({ ...config(), database }),
    /TLS_REQUIRED/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config(),
        database: { ...database, host: "127.0.0.1", user: "root" },
      }),
    /DATABASE_CONFIG_INVALID/,
  );
});

test("authenticated session is freshly verified against existing ArtFi endpoint and chain", async () => {
  const session = await auth()(request());
  assert.equal(session.wallet, wallet);
  assert.equal(session.expiresAt, 3000);
  for (const header of [
    "authorization",
    "x-artfi-user-access",
    "x-artfi-web-origin",
  ]) {
    const req = request();
    delete req.headers[header];
    await assert.rejects(auth()(req));
  }
  for (const patch of [
    { chainId: 1 },
    { expiresAt: 900 },
    { accessExpiresAt: 900 },
    { accessExpiresAt: 5000 },
    { address: "invalid" },
  ]) {
    const authenticate = auth({
      fetchImpl: async () =>
        Response.json({
          session: {
            id: "test",
            address: wallet,
            chainId: 560048,
            expiresAt: 4000,
            accessExpiresAt: 3000,
            ...patch,
          },
        }),
    });
    await assert.rejects(
      authenticate(request()),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
  }
});

test("upstream auth failure never logs or returns tokens or raw errors", async () => {
  await assert.rejects(
    auth({
      fetchImpl: async () => {
        throw Error("sensitive upstream error");
      },
    })(request()),
    /^Error: SESSION_DEPENDENCY_UNAVAILABLE$/,
  );
  await assert.rejects(
    auth({ fetchImpl: async () => new Response("secret", { status: 401 }) })(
      request(),
    ),
    /AUTHENTICATED_SESSION_REQUIRED/,
  );
});

async function withServer(options, work) {
  const server = createAgentHTTPServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
const headers = {
  authorization: `Bearer ${bridge}`,
  "x-artfi-user-access": access,
  "x-artfi-web-origin": origin,
};
test("actual loopback HTTP is authenticated, no-store, unavailable without dependencies", async () => {
  await withServer(
    {
      authenticate: auth(),
      getRuntimeStatus: unavailableCapabilities,
      getService: () => null,
    },
    async (base) => {
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).productionReady, false);
      assert.equal((await fetch(`${base}/v1/agent/status`)).status, 401);
      const status = await fetch(`${base}/v1/agent/status`, { headers });
      assert.equal(status.status, 200);
      assert.match(status.headers.get("cache-control"), /no-store/);
      const body = await status.json();
      assert.equal(body.state, "SAFE_DEGRADED");
      assert.equal(body.capabilities.signIntent, false);
      assert.equal(body.constitutionalMutations, false);
      assert.equal(
        (await fetch(`${base}/v1/agent/intents/abc`, { headers })).status,
        503,
      );
    },
  );
});

test("HTTP scope accepts only bounded endpoints and binds calls to verified identity", async () => {
  let preparations = 0;
  const service = {
    prepareIntent: async (session, input) => {
      preparations++;
      assert.equal(session.wallet, wallet);
      return { test: true, input };
    },
    getIntent: async (session, id) => ({ id, wallet: session.wallet }),
    getHistory: async (session, id, page) => ({ id, page }),
    recordRevocation: async () => ({ state: "PENDING" }),
  };
  await withServer(
    {
      authenticate: auth(),
      getRuntimeStatus: unavailableCapabilities,
      getService: () => service,
    },
    async (base) => {
      const valid = {
        contract: wallet,
        tokenId: "1",
        maxUnitPrice: "10",
        validUntil: "9999",
      };
      const post = (body) =>
        fetch(`${base}/v1/agent/intents/prepare`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      assert.equal(
        (await post({ ...valid, session: { authenticated: true, wallet } }))
          .status,
        400,
      );
      assert.equal((await post(valid)).status, 200);
      assert.equal(preparations, 1);
      assert.equal(
        (
          await fetch(`${base}/v1/agent/intents/abc/history?limit=1000`, {
            headers,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${base}/v1/agent/intents/abc/history?after=1&after=2`, {
            headers,
          })
        ).status,
        400,
      );
      assert.equal(
        (await fetch(`${base}/v1/agent/sign`, { method: "POST", headers }))
          .status,
        404,
      );
      assert.equal(
        (
          await fetch(`${base}/v1/agent/constitutional/upgrade`, {
            method: "POST",
            headers,
          })
        ).status,
        404,
      );
      const read = await fetch(`${base}/v1/agent/intents/abc`, { headers });
      assert.deepEqual(await read.json(), { id: "abc", wallet });
    },
  );
});

test("autonomous unavailable controller keeps polling and stops without manual repair", async () => {
  const abort = new AbortController();
  let notifications = 0;
  const controller = createRuntimeController({
    config: validateConfig(config()),
    onState: () => {
      notifications++;
      if (notifications === 2) abort.abort();
    },
  });
  await controller.run({ signal: abort.signal });
  assert.equal(notifications, 2);
  assert.equal(controller.getStatus().state, "SAFE_DEGRADED");
  assert.equal(controller.getStatus().reason, "AGENT_DATABASE_UNCONFIGURED");
  await controller.close();
});

test("configured bounded profile remains unavailable and cannot select the isolated signer fixture", async () => {
  const selected = validateConfig({
    ...config(),
    mode: "BOUNDED_SIGNED_AUTHORITY",
    authentication: {
      apiURL: "http://127.0.0.1:8080",
      allowedChainIds: [1, 8453],
    },
  });
  assert.equal(selected.mode, "BOUNDED_SIGNED_AUTHORITY");
  assert.throws(
    () =>
      validateConfig({
        ...selected,
        adapter: {
          kind: "artfi-isolated-test-v1",
          baseURL: "http://127.0.0.1:33328",
          tokenFile: "/test-only/token",
        },
      }),
    /ISOLATED_ADAPTER_MODE_REFUSED/,
  );
  const controller = createRuntimeController({ config: selected });
  assert.equal(controller.getStatus().mode, "BOUNDED_SIGNED_AUTHORITY");
  assert.equal(controller.getStatus().state, "SAFE_DEGRADED");
  assert.equal(controller.getStatus().capabilities.signIntent, false);
  await controller.close();
});

test("startup schema timeout discards an in-flight connection and never waits forever", async () => {
  const { assertDatabaseSchema } = await import("../src/mysql-pool.mjs");
  let destroyed = 0,
    released = 0;
  await assert.rejects(
    assertDatabaseSchema(
      {
        getConnection: async () => ({
          execute: async () => new Promise(() => {}),
          destroy: () => destroyed++,
          release: () => released++,
        }),
      },
      10,
    ),
    /AGENT_SCHEMA_UNAVAILABLE/,
  );
  assert.equal(destroyed, 1);
  assert.equal(released, 0);
});
test("late startup connection acquisition is discarded after the bounded timeout", async () => {
  const { assertDatabaseSchema } = await import("../src/mysql-pool.mjs");
  let acquired,
    destroyed = 0;
  const pending = assertDatabaseSchema(
    {
      getConnection: () =>
        new Promise((resolve) => {
          acquired = resolve;
        }),
    },
    10,
  );
  await assert.rejects(pending, /AGENT_SCHEMA_UNAVAILABLE/);
  acquired({
    destroy: () => destroyed++,
    execute: () => {
      throw Error("UNEXPECTED_QUERY");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(destroyed, 1);
});
