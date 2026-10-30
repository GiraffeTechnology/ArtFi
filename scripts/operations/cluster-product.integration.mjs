import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";
import { renderCluster } from "./cluster-config.mjs";
const { Wallet } = createRequire(
  new URL("../../apps/agent-runtime/package.json", import.meta.url),
)("ethers");
const nginx = process.env.ARTFI_TEST_NGINX,
  bundle = process.env.ARTFI_TEST_BUNDLE_ROOT,
  dsn = process.env.ARTFI_INTEGRATION_MYSQL_DSN;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function port() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return n;
}
async function wait(url) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("ArtFi service did not become ready.");
}
async function stop(p) {
  if (p.exitCode !== null || p.signalCode) return;
  p.kill("SIGTERM");
  await Promise.race([
    once(p, "exit"),
    delay(3000).then(() => {
      if (p.exitCode === null) p.kill("SIGKILL");
    }),
  ]);
}
test(
  "two real packaged web nodes and Go API processes share durable login across load-balancer failover",
  { skip: !nginx || !bundle || !dsn, timeout: 60000 },
  async (t) => {
    const dir = await mkdtemp(
      join(
        resolve(process.env.ARTFI_TEST_OUTPUT || tmpdir()),
        "artfi-product-lb-",
      ),
    );
    const [wl, wa, wb, al, aa, ab] = await Promise.all(
      Array.from({ length: 6 }, port),
    );
    const origin = `http://127.0.0.1:${wl}`,
      apiURL = `http://127.0.0.1:${al}`;
    const cfg = {
      format: 1,
      purpose: "isolated-test",
      runtimeDirectory: dir,
      web: {
        listen: `127.0.0.1:${wl}`,
        backends: [`127.0.0.1:${wa}`, `127.0.0.1:${wb}`],
      },
      api: {
        listen: `127.0.0.1:${al}`,
        backends: [`127.0.0.1:${aa}`, `127.0.0.1:${ab}`],
      },
    };
    for (const d of ["logs", "client-body", "proxy"]) await mkdir(join(dir, d));
    await writeFile(join(dir, "nginx.conf"), renderCluster(cfg));
    const children = [];
    const logs = [];
    const launch = (name, exe, args, env = {}, cwd) => {
      const p = spawn(exe, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(p);
      p.stdout.on("data", (b) => logs.push(`${name}: ${b}`));
      p.stderr.on("data", (b) => logs.push(`${name}: ${b}`));
      return p;
    };
    t.after(async () => {
      for (const p of children.reverse()) await stop(p);
      await writeFile(join(dir, "services.log"), logs.join(""));
    });
    const shared = {
      NODE_ENV: "production",
      ARTFI_WEB_URL: origin,
      ARTFI_WEB_ORIGIN: origin,
      ARTFI_API_URL: apiURL,
      ARTFI_USER_AUTH_API_URL: apiURL,
      ARTFI_USER_AUTH_CHAIN_IDS: "560048",
      MYSQL_DSN: dsn,
      ARTFI_USER_SESSION_SECRET:
        "TEST_ONLY_cluster_session_111111111111111111111",
      ARTFI_USER_AUTH_BRIDGE_TOKEN:
        "TEST_ONLY_cluster_bridge_222222222222222222222",
    };
    const api =
      process.env.ARTFI_TEST_API_BINARY ||
      join(bundle, "runtime/bin/artfi-api");
    const startAPI = (p, name) =>
      launch(name, api, [], { ...shared, ARTFI_API_ADDR: `127.0.0.1:${p}` });
    const startWeb = (p, name) =>
      launch(
        name,
        join(bundle, "runtime/bin/node"),
        [join(bundle, "runtime/web/apps/web/server.js")],
        { ...shared, HOSTNAME: "127.0.0.1", PORT: String(p) },
        join(bundle, "runtime/web/apps/web"),
      );
    const a = startAPI(aa, "api-a");
    startAPI(ab, "api-b");
    const w = startWeb(wa, "web-a");
    startWeb(wb, "web-b");
    for (const p of [aa, ab]) await wait(`http://127.0.0.1:${p}/readyz`);
    for (const p of [wa, wb]) await wait(`http://127.0.0.1:${p}/api/health`);
    launch("nginx", nginx, [
      "-p",
      dir + "/",
      "-c",
      join(dir, "nginx.conf"),
      "-g",
      "daemon off; master_process off;",
    ]);
    await wait(origin + "/api/health");
    const jar = new Map();
    async function auth(url, action, body) {
      const r = await fetch(`${url}/api/user/auth/${action}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const cookie of r.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const eq = pair.indexOf("=");
        if (pair.slice(eq + 1)) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
        else jar.delete(pair.slice(0, eq));
      }
      return r;
    }
    const account = Wallet.createRandom(); // Ephemeral TEST_ONLY message signer, never saved or used on a chain.
    let response = await auth(`http://127.0.0.1:${wa}`, "challenge", {
      address: account.address,
      chainId: 560048,
    });
    assert.equal(response.status, 200);
    const challenge = await response.json();
    response = await auth(`http://127.0.0.1:${wb}`, "verify", {
      address: challenge.address,
      chainId: 560048,
      signature: await account.signMessage(challenge.message),
    });
    assert.equal(response.status, 200);
    const session = (await response.json()).session;
    assert.equal(session.address.toLowerCase(), account.address.toLowerCase());
    for (let i = 0; i < 8; i++) {
      response = await auth(origin, "session");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).session.id, session.id);
    }
    response = await auth(`http://127.0.0.1:${wa}`, "refresh", {});
    assert.equal(response.status, 200);
    response = await auth(`http://127.0.0.1:${wb}`, "session");
    assert.equal(response.status, 200);
    await stop(a);
    await stop(w);
    // Passive failover may expose a transient unavailable read after a compound
    // web/API outage. It must recover within the bounded window without losing
    // or recreating the authenticated session. Never resend a user mutation.
    let transientReadFailures = 0;
    const recoveryStarted = Date.now();
    do {
      response = await auth(origin, "session");
      if (response.status === 200) break;
      assert.ok([502, 503].includes(response.status));
      transientReadFailures++;
      await delay(150);
    } while (Date.now() - recoveryStarted < 10000);
    assert.equal(
      response.status,
      200,
      "compound outage did not recover within ten seconds",
    );
    const recoveryMs = Date.now() - recoveryStarted;
    for (let i = 0; i < 6; i++) {
      response = await auth(origin, "session");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).session.id, session.id);
    }
    startAPI(aa, "api-a-recovered");
    startWeb(wa, "web-a-recovered");
    await wait(`http://127.0.0.1:${aa}/readyz`);
    await wait(`http://127.0.0.1:${wa}/api/health`);
    response = await auth(`http://127.0.0.1:${wa}`, "session");
    assert.equal(response.status, 200);
    const beforeLogout = new Map(jar);
    response = await auth(`http://127.0.0.1:${wb}`, "logout", {});
    assert.equal(response.status, 200);
    jar.clear();
    for (const [k, v] of beforeLogout) jar.set(k, v);
    response = await auth(`http://127.0.0.1:${wa}`, "session");
    assert.equal(
      response.status,
      401,
      "the other live node must see persisted logout",
    );
    const records = (await readFile(join(dir, "access.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    for (const port of [aa, ab, wa, wb])
      assert.ok(
        records.some((r) => r.upstream.includes(String(port))),
        `pool did not serve from ${port}`,
      );
    console.log(
      JSON.stringify({
        evidenceDirectory: dir,
        realWebNodes: 2,
        realAPINodes: 2,
        sharedSession: true,
        refresh: true,
        backendFailover: true,
        transientReadFailures,
        recoveryMs,
        recovery: true,
        crossNodeLogout: true,
        requests: records.length,
      }),
    );
  },
);
