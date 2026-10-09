import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { isSameProcess, readProcessIdentity } from "./process-info.mjs";

test("service identity survives Next-style process title changes and rejects reused identities", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.title="renamed-next-server";console.log("ready");setInterval(()=>{},1000)',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await once(child.stdout, "data");
    const record = {
      pid: child.pid,
      ...(await readProcessIdentity(child.pid)),
    };
    assert.equal(await isSameProcess(record), true);
    assert.equal(
      await isSameProcess({ ...record, started: "incorrect" }),
      false,
    );
    assert.equal(
      await isSameProcess({ ...record, executable: "incorrect" }),
      false,
    );
    child.kill("SIGTERM");
    await once(child, "exit");
    assert.equal(await isSameProcess(record), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});
