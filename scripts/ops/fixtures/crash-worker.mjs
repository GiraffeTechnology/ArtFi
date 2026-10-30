// Test-only synthetic receiver/process fixture. Never used by monitor-service.
import { readFile, open } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { Monitor } from "../monitor-core.mjs";

try {
  const [directory, mode] = process.argv.slice(2);
  if (
    !process.send ||
    !isAbsolute(directory) ||
    !basename(directory).startsWith("artfi-crash-test-") ||
    !["after-persist", "after-receive", "complete"].includes(mode)
  )
    throw Error("TEST_WORKER_INPUT_REFUSED");
  const receiverPath = join(directory, "synthetic-receiver.json");
  let calls = 0;
  const monitor = new Monitor({
    directory,
    environment: "test",
    threshold: 1,
    timeoutMs: 30000,
    now: () => 10000,
    checks: [{ id: "synthetic-api", category: "api", maxAgeMs: 1000 }],
    probe: async () => ({ observedAt: 10000, available: false }),
    classify: async () => {
      if (mode === "after-persist") {
        process.send({ stage: "persisted" });
        await new Promise(() => {});
      }
      return { recommendation: "human-review" };
    },
    notify: async (event) => {
      calls++;
      let receiver;
      try {
        receiver = JSON.parse(await readFile(receiverPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        receiver = { acceptedIds: [] };
      }
      if (!receiver.acceptedIds.includes(event.id))
        receiver.acceptedIds.push(event.id);
      const file = await open(receiverPath, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(receiver));
        await file.sync();
      } finally {
        await file.close();
      }
      if (mode === "after-receive") {
        process.send({ stage: "received-before-ack", id: event.id });
        await new Promise(() => {});
      }
      return { id: event.id, accepted: true };
    },
  });
  const state = await monitor.tick();
  process.send(
    {
      stage: "complete",
      calls,
      queue: state.queue.map((event) => ({
        id: event.id,
        delivery: event.delivery,
        attempts: event.attempts,
      })),
    },
    () => process.disconnect(),
  );
} catch {
  process.send?.({ stage: "TEST_WORKER_FAILED" }, () => process.disconnect());
  process.exitCode = 1;
}
