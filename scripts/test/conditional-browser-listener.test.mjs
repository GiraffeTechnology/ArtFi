import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { waitForOwnedListener } from "../../apps/agent-runtime/test/owned-fixture-listener.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
function fakeChild() {
  return Object.assign(new EventEmitter(), {
    pid: 42,
    connected: true,
    exitCode: null,
    signalCode: null,
  });
}
test("owned listener rejects another process identity and removes only its own handlers", async () => {
  const child = fakeChild();
  const unrelated = () => {};
  child.on("message", unrelated);
  const result = waitForOwnedListener(child);
  child.emit("message", {
    type: "ARTFI_TEST_OWNED_LISTENER",
    pid: 43,
    host: "127.0.0.1",
    port: 33328,
  });
  await assert.rejects(result, /ISOLATED_LISTENER_OWNERSHIP_INVALID/);
  assert.deepEqual(child.listeners("message"), [unrelated]);
  assert.equal(child.listenerCount("exit"), 0);
});
test("owned listener refuses nonloopback and invalid ports", async () => {
  for (const patch of [
    { host: "0.0.0.0" },
    { port: 0 },
    { port: 65536 },
    { port: "33328" },
  ]) {
    const child = fakeChild(),
      result = waitForOwnedListener(child);
    child.emit("message", {
      type: "ARTFI_TEST_OWNED_LISTENER",
      pid: 42,
      host: "127.0.0.1",
      port: 33328,
      ...patch,
    });
    await assert.rejects(result, /ISOLATED_LISTENER_OWNERSHIP_INVALID/);
  }
});
test("owned listener never treats exit or a missing handshake as readiness", async () => {
  const child = fakeChild(),
    result = waitForOwnedListener(child);
  child.emit("exit", 1);
  await assert.rejects(result, /ISOLATED_SERVER_EXITED_BEFORE_READY/);
  const silent = fakeChild();
  await assert.rejects(
    waitForOwnedListener(silent, 20),
    /ISOLATED_SERVER_START_TIMEOUT/,
  );
  assert.equal(silent.listenerCount("message"), 0);
});
async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    await stopped;
  } finally {
    clearTimeout(timer);
  }
}
test("two real adapter fixtures own distinct OS-assigned listeners and both close", async () => {
  const children = [];
  const start = () => {
    const child = spawn(
      process.execPath,
      [join(root, "apps/agent-runtime/test/browser-adapter-fixture.mjs")],
      {
        cwd: root,
        env: {
          ...process.env,
          ARTFI_AGENT_TEST_ADAPTER_TOKEN:
            "TEST_ONLY_LOCAL_BROWSER_ADAPTER_CREDENTIAL",
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    children.push(child);
    return waitForOwnedListener(child);
  };
  let urls;
  try {
    urls = await Promise.all([start(), start()]);
    assert.notEqual(urls[0], urls[1]);
    const info = await Promise.all(
      urls.map(async (url) => {
        const response = await fetch(`${url}/test-only/info`, {
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(response.status, 200);
        return response.json();
      }),
    );
    assert.ok(
      info.every(
        (row) =>
          row.mode === "TEST_ONLY_NO_REAL_VALUE" && row.executeCalls === 0,
      ),
    );
    assert.notEqual(info[0].asset, info[1].asset);
  } finally {
    await Promise.all(children.map(stopOwned));
  }
  for (const url of urls)
    await assert.rejects(
      fetch(`${url}/test-only/info`, { signal: AbortSignal.timeout(1000) }),
    );
});
