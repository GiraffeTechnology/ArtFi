import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { renderCluster } from "./cluster-config.mjs";
const nginx = process.env.ARTFI_TEST_NGINX;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function wait(url) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Service did not start: ${url}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    delay(3000).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}
test(
  "real nginx balances, survives stopped backend, recovers, and does not replay a dispatched POST",
  { skip: !nginx, timeout: 40000 },
  async (t) => {
    const dir = await mkdtemp(
      join(resolve(process.env.ARTFI_TEST_OUTPUT || tmpdir()), "artfi-lb-"),
    );
    const ports = await Promise.all(Array.from({ length: 8 }, port));
    const [webListen, wa, wb, apiListen, aa, ab, ba, bb] = ports;
    const config = {
      format: 1,
      purpose: "isolated-test",
      runtimeDirectory: dir,
      web: {
        listen: `127.0.0.1:${webListen}`,
        backends: [`127.0.0.1:${wa}`, `127.0.0.1:${wb}`],
      },
      api: {
        listen: `127.0.0.1:${apiListen}`,
        backends: [`127.0.0.1:${aa}`, `127.0.0.1:${ab}`],
      },
      bffExecution: {
        executionZone: "sin",
        backends: [`127.0.0.1:${ba}`, `127.0.0.1:${bb}`],
      },
    };
    await mkdir(join(dir, "logs"));
    await mkdir(join(dir, "client-body"));
    await mkdir(join(dir, "proxy"));
    await writeFile(join(dir, "nginx.conf"), renderCluster(config));
    const children = [];
    let logs = "";
    const child = (exe, args, env = {}) => {
      const p = spawn(exe, args, {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(p);
      p.stdout.on("data", (b) => (logs += b));
      p.stderr.on("data", (b) => (logs += b));
      return p;
    };
    t.after(async () => {
      for (const p of children.reverse()) await stop(p);
      await writeFile(join(dir, "processes.log"), logs);
    });
    const stub = `import http from 'node:http';import fs from 'node:fs';http.createServer((q,s)=>{fs.appendFileSync(process.env.RECEIPTS,JSON.stringify({method:q.method,path:q.url,node:process.env.NODE_ID})+'\\n');if(q.method==='POST'&&q.url==='/uncertain'){q.resume();q.on('end',()=>q.socket.destroy());return;}s.setHeader('Content-Type','application/json');s.end(JSON.stringify({node:process.env.NODE_ID,method:q.method,host:q.headers.host,forwarded:q.headers['x-forwarded-proto']}));}).listen(Number(process.env.PORT),'127.0.0.1');`;
    await writeFile(join(dir, "backend.mjs"), stub);
    const start = (p, id) =>
      child(process.execPath, [join(dir, "backend.mjs")], {
        PORT: String(p),
        NODE_ID: id,
        RECEIPTS: join(dir, "receipts.jsonl"),
      });
    const a = start(wa, "web-a");
    start(wb, "web-b");
    start(aa, "api-a");
    start(ab, "api-b");
    start(ba, "execution-a");
    start(bb, "execution-b");
    for (const p of [wa, wb, aa, ab, ba, bb])
      await wait(`http://127.0.0.1:${p}/`);
    const syntax = child(nginx, [
      "-t",
      "-p",
      dir + "/",
      "-c",
      join(dir, "nginx.conf"),
    ]);
    assert.equal((await once(syntax, "exit"))[0], 0, logs);
    child(nginx, [
      "-p",
      dir + "/",
      "-c",
      join(dir, "nginx.conf"),
      "-g",
      "daemon off; master_process off;",
    ]);
    const base = `http://127.0.0.1:${webListen}`;
    await wait(base);
    const nodes = new Set();
    for (let i = 0; i < 8; i++)
      nodes.add((await (await fetch(base)).json()).node);
    assert.deepEqual([...nodes].sort(), ["web-a", "web-b"]);
    const apiNodes = new Set();
    for (let i = 0; i < 6; i++)
      apiNodes.add(
        (await (await fetch(`http://127.0.0.1:${apiListen}`)).json()).node,
      );
    assert.deepEqual([...apiNodes].sort(), ["api-a", "api-b"]);
    const executionNodes = new Set();
    for (let i = 0; i < 6; i++)
      executionNodes.add(
        (await (await fetch(`${base}/api/nft/catalog`)).json()).node,
      );
    assert.deepEqual([...executionNodes].sort(), [
      "execution-a",
      "execution-b",
    ]);
    const response = await fetch(`${base}/uncertain`, {
      method: "POST",
      body: "TEST_ONLY bounded operation",
    });
    assert.equal(response.status, 502);
    const records = (await readFile(join(dir, "receipts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      records.filter((r) => r.path === "/uncertain").length,
      1,
      "a dispatched write must not be resent to another node",
    );
    // Let the deliberately failed POST node complete its passive recovery window before a distinct outage.
    await delay(2200);
    for (let i = 0; i < 4; i++) assert.equal((await fetch(base)).status, 200);
    await stop(a);
    for (let i = 0; i < 6; i++) {
      const r = await fetch(base);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).node, "web-b");
    }
    start(wa, "web-a");
    await wait(`http://127.0.0.1:${wa}/`);
    const recovered = new Set();
    const recoveryDeadline = Date.now() + 10000;
    while (recovered.size < 2 && Date.now() < recoveryDeadline) {
      recovered.add((await (await fetch(base)).json()).node);
      await delay(100);
    }
    assert.deepEqual([...recovered].sort(), ["web-a", "web-b"]);
    const access = (await readFile(join(dir, "access.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(access.every((r) => r.requestId && r.status && r.duration >= 0));
    assert.ok(access.some((r) => r.upstream.includes(String(wa))));
    assert.ok(access.some((r) => r.upstream.includes(String(wb))));
    console.log(
      JSON.stringify({
        evidenceDirectory: dir,
        version: "nginx",
        requests: access.length,
        backendRecovery: true,
        separateExecutionBffRouting: true,
        dispatchedWriteNotReplayed: true,
      }),
    );
  },
);
