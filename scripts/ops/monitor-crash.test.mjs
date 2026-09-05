import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workerPath = fileURLToPath(
  new URL("./fixtures/crash-worker.mjs", import.meta.url),
);
function worker(directory, mode, targetStage) {
  const child = fork(workerPath, [directory, mode], {
    silent: true,
    windowsHide: true,
  });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  child.stdout.resume();
  child.stderr.resume();
  const reached = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("TEST_WORKER_TIMEOUT"));
    }, 8000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("TEST_WORKER_SPAWN_FAILED"));
    });
    child.on("message", (message) => {
      if (message.stage === targetStage) {
        clearTimeout(timer);
        resolve(message);
      } else if (message.stage === "TEST_WORKER_FAILED") {
        clearTimeout(timer);
        reject(Error(message.stage));
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(Error("TEST_WORKER_CLOSED_BEFORE_STAGE"));
    });
  });
  return { child, closed, reached };
}

for (const mode of ["after-persist", "after-receive"]) {
  test(`actual process crash ${mode} resumes durable incident without duplicate receiver effect`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "artfi-crash-test-"));
    const children = [];
    t.after(async () => {
      for (const current of children) {
        if (
          current.child.exitCode === null &&
          current.child.signalCode === null
        )
          current.child.kill("SIGKILL");
        await current.closed;
      }
      await rm(directory, { recursive: true, force: true });
    });
    const first = worker(
      directory,
      mode,
      mode === "after-persist" ? "persisted" : "received-before-ack",
    );
    children.push(first);
    await first.reached;
    const persisted = JSON.parse(
      await readFile(join(directory, "monitor-state.json"), "utf8"),
    );
    assert.equal(persisted.queue.length, 1);
    const originalId = persisted.queue[0].id;
    assert.equal(persisted.queue[0].delivery, "pending");
    assert.equal(first.child.kill("SIGKILL"), true);
    await first.closed;
    const restarted = worker(directory, "complete", "complete");
    children.push(restarted);
    const result = await restarted.reached;
    assert.equal((await restarted.closed).code, 0);
    assert.equal(result.queue.length, 1);
    assert.equal(result.queue[0].id, originalId);
    assert.equal(result.queue[0].delivery, "delivered");
    assert.equal(result.queue[0].attempts, mode === "after-receive" ? 2 : 1);
    assert.equal(result.calls, 1);
    const receiver = JSON.parse(
      await readFile(join(directory, "synthetic-receiver.json"), "utf8"),
    );
    assert.deepEqual(receiver.acceptedIds, [originalId]);
  });
}
