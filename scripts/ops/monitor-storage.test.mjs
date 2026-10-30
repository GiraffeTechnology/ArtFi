import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicJson } from "./monitor-core.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-storage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "monitor-state.json") };
}

test("failed rename preserves destination and removes only its owned temporary file", async (t) => {
  const { directory, path } = await fixture(t);
  await mkdir(path);
  await writeFile(join(path, "existing-state"), "preserve");
  await writeFile(join(directory, "unrelated.tmp"), "preserve-other");
  await assert.rejects(atomicJson(path, { heartbeatAt: 2 }), {
    message: "MONITOR_STATE_WRITE_REFUSED",
  });
  assert.equal(
    await readFile(join(path, "existing-state"), "utf8"),
    "preserve",
  );
  assert.deepEqual((await readdir(directory)).sort(), [
    "monitor-state.json",
    "unrelated.tmp",
  ]);
  assert.equal(
    await readFile(join(directory, "unrelated.tmp"), "utf8"),
    "preserve-other",
  );
});

test("serialization failure leaves pending state and heartbeat unchanged without temporary residue", async (t) => {
  const { directory, path } = await fixture(t);
  const previous = JSON.stringify({
    heartbeatAt: 1,
    queue: [{ id: "test-pending", delivery: "pending" }],
  });
  await writeFile(path, previous);
  await assert.rejects(atomicJson(path, { heartbeatAt: 2, invalid: 1n }), {
    message: "MONITOR_STATE_SERIALIZATION_REFUSED",
  });
  assert.equal(await readFile(path, "utf8"), previous);
  assert.deepEqual(await readdir(directory), ["monitor-state.json"]);
});

test("successful atomic replacement persists complete JSON without temporary residue", async (t) => {
  const { directory, path } = await fixture(t);
  await writeFile(path, '{"heartbeatAt":1}');
  const next = { heartbeatAt: 2, queue: [{ delivery: "pending" }] };
  await atomicJson(path, next);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), next);
  assert.deepEqual(await readdir(directory), ["monitor-state.json"]);
});
