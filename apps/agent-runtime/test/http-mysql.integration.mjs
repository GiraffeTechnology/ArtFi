import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startAgentServer } from "../src/server.mjs";
import { validateConfig, MODE } from "../src/config.mjs";
import { TEST_ADAPTER_CONTRACT } from "../src/adapter.mjs";
import { actionFixture, syntheticEvidence } from "./action-fixtures.mjs";
const configPath = process.env.ARTFI_AGENT_TEST_MYSQL_CONFIG;
const database = JSON.parse(await readFile(configPath, "utf8"));
assert.equal(database.database, "artfi_stage2_isolated_test");
const credentials = {
  ARTFI_AGENT_BRIDGE_TOKEN: "ISOLATED_HTTP_AGENT_BRIDGE_CREDENTIAL",
  ARTFI_USER_AUTH_BRIDGE_TOKEN: "ISOLATED_HTTP_AUTH_BRIDGE_CREDENTIAL",
};
const adapterToken = "ISOLATED_HTTP_ADAPTER_CREDENTIAL";
const access = "ISOLATED_HTTP_AUTHENTICATED_USER_ACCESS";
const origin = "http://127.0.0.1:3000";
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
async function json(request) {
  let text = "";
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 131072) throw Error("ISOLATED_TEST_BODY_TOO_LARGE");
  }
  return JSON.parse(text);
}
const respond = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test("full packaged runtime composes real MySQL, authenticated HTTP, fixed test adapter and autonomous action recovery", async () => {
  const fixture = await actionFixture(),
    externalEvidence = new Map();
  let authorized = true,
    currentWallet = fixture.user.address,
    sends = 0;
  const auth = await listen(async (request, response) => {
    if (
      request.url !== "/approved-prefix/v1/user/auth/session" ||
      request.headers.authorization !==
        `Bearer ${credentials.ARTFI_USER_AUTH_BRIDGE_TOKEN}`
    )
      return respond(response, 404, {});
    const body = await json(request);
    if (!authorized || body.accessToken !== access)
      return respond(response, 401, {});
    return respond(response, 200, {
      session: {
        id: "isolated-http-session",
        address: currentWallet,
        chainId: 560048,
        expiresAt: Date.now() + 600000,
        accessExpiresAt: Date.now() + 60000,
      },
    });
  });
  const adapter = await listen(async (request, response) => {
    if (
      request.headers.authorization !== `Bearer ${adapterToken}` ||
      request.headers["x-artfi-test-contract"] !== TEST_ADAPTER_CONTRACT
    )
      return respond(response, 401, {});
    try {
      const { input, mode, contract } = await json(request);
      if (mode !== MODE || contract !== TEST_ADAPTER_CONTRACT)
        throw Error("fixture contract");
      const method = request.url.split("/").at(-1);
      let result;
      if (method === "policy")
        result = {
          ...fixture.policy,
          collection: fixture.asset,
          paymentToken: fixture.payment,
          venue: fixture.market,
          actionPolicy: fixture.policy,
        };
      else if (method === "action-observe") result = fixture.observe(input.leg);
      else if (method === "action-execute") {
        sends++;
        const { leg, context } = input;
        const evidence = syntheticEvidence(
          leg,
          context.operationId,
          context.legIndex,
        );
        externalEvidence.set(
          `${context.operationId}:${context.legIndex}`,
          evidence,
        );
        result = { transactionHash: evidence.transaction.hash };
      } else if (method === "action-evidence")
        result =
          externalEvidence.get(`${input.record.id}:${input.record.cursor}`) ??
          null;
      else if (method === "mint-authority")
        result = {
          status: "UNKNOWN",
          reason: "ISOLATED_FIXTURE_NO_LEGACY_PROOF",
        };
      else if (method === "observe")
        result = { available: false, current: false, observedAt: Date.now() };
      else throw Error("fixture unsupported");
      respond(response, 200, {
        contract: TEST_ADAPTER_CONTRACT,
        mode: MODE,
        isolated: true,
        result,
      });
    } catch {
      respond(response, 503, { code: "ISOLATED_FIXTURE_UNAVAILABLE" });
    }
  });
  const tokenFile = join(dirname(configPath), "adapter-test-token");
  await writeFile(tokenFile, adapterToken, { mode: 0o600 });
  const config = validateConfig({
    schemaVersion: 1,
    mode: MODE,
    listen: { host: "127.0.0.1", port: 33327 },
    webOrigin: origin,
    authentication: { apiURL: `${auth.url}/approved-prefix` },
    database,
    adapter: {
      kind: "artfi-isolated-test-v1",
      baseURL: adapter.url,
      tokenFile,
    },
    worker: { intervalMs: 100 },
  });
  let runtime;
  const headers = {
    authorization: `Bearer ${credentials.ARTFI_AGENT_BRIDGE_TOKEN}`,
    "x-artfi-user-access": access,
    "x-artfi-web-origin": origin,
    "content-type": "application/json",
  };
  const api = (path, body) =>
    fetch(`http://127.0.0.1:33327/v1/agent/${path}`, {
      headers,
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    runtime = await startAgentServer({ config, environment: credentials });
    const deadline = Date.now() + 10000;
    let status;
    while (Date.now() < deadline) {
      status = await (await api("status")).json();
      if (status.capabilities?.actionWorkflows) break;
      await delay(100);
    }
    assert.equal(status.capabilities.actionWorkflows, true);
    assert.equal(status.capabilities.signIntent, false);
    assert.equal(status.productionReady, false);
    const plan = fixture.compile({ ...(await fixture.order()), quantity: "2" });
    assert.equal(
      (
        await fetch("http://127.0.0.1:33327/v1/agent/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    const accepted = await api("actions", {
      authority: fixture.envelope,
      request: plan.request,
    });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).state, "PLANNED");
    let record;
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      record = await (await api(`actions/${plan.operationId}`)).json();
      if (record.state === "COMPLETED") break;
      await delay(100);
    }
    assert.equal(record.state, "COMPLETED");
    assert.equal(record.supportLevel, "ISOLATED_APP_SIDE_CONTRACT");
    assert.equal(sends, 1);
    assert.equal(record.steps[0].evidence.verified, true);
    assert.equal(
      JSON.stringify(record).includes(fixture.envelope.signature),
      false,
    );
    const history = await (
      await api(`actions/${plan.operationId}/history`)
    ).json();
    assert.ok(history.events.some((x) => x.state === "STARTED"));
    assert.ok(history.events.some((x) => x.state === "COMPLETED"));
    currentWallet = fixture.seller.address;
    const other = await api(`actions/${plan.operationId}`);
    assert.equal(other.status, 404);
    assert.equal((await other.text()).includes(plan.operationId), false);
    currentWallet = fixture.user.address;
    await runtime.close();
    runtime = await startAgentServer({ config, environment: credentials });
    const restoredEnd = Date.now() + 10000;
    while (Date.now() < restoredEnd) {
      const response = await api(`actions/${plan.operationId}`);
      if (response.status === 200) {
        record = await response.json();
        break;
      }
      await delay(100);
    }
    assert.equal(record.state, "COMPLETED");
    assert.equal(sends, 1);
    authorized = false;
    assert.equal((await api(`actions/${plan.operationId}`)).status, 401);
  } finally {
    await runtime?.close();
    await close(auth.server);
    await close(adapter.server);
  }
});
