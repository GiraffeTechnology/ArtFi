import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { monitorArguments, readMonitorArguments } from "./monitor-entry.mjs";

const source = dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-monitor-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "private-monitor.json");
  return { directory, file };
}
test("monitor entry preserves the format-1 implementation and watch argument", () => {
  assert.deepEqual(
    monitorArguments("/release", "/private/monitor.json", {
      format: 1,
      probes: [],
    }),
    [
      "/release/tools/operations/monitor.mjs",
      "/private/monitor.json",
      "--watch",
    ],
  );
});
test("monitor entry explicitly selects durable monitor-only without legacy watch", () => {
  assert.deepEqual(
    monitorArguments("/release", "/private/monitor.json", {
      schemaVersion: 1,
      mode: "monitor-only",
    }),
    ["/release/tools/ops/monitor-service.mjs", "/private/monitor.json"],
  );
});
test("monitor entry refuses ambiguous, absent or unsupported descriptor identity", () => {
  for (const value of [
    null,
    [],
    {},
    { format: 2 },
    { schemaVersion: 1 },
    { schemaVersion: 1, mode: "execute" },
    { format: 1, schemaVersion: 1, mode: "monitor-only" },
  ])
    assert.throws(
      () => monitorArguments("/release", "/private/monitor.json", value),
      /DESCRIPTOR_REFUSED/,
    );
  for (const file of [undefined, "relative", "/private/bad\npath"])
    assert.throws(
      () => monitorArguments("/release", file, { format: 1 }),
      /DESCRIPTOR_REFUSED/,
    );
});
test("monitor entry reads private descriptors without modifying either schema", async (t) => {
  const f = await fixture(t);
  for (const value of [
    { format: 1, probes: [] },
    { schemaVersion: 1, mode: "monitor-only" },
  ]) {
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(f.file, bytes, { mode: 0o600 });
    assert.deepEqual(
      await readMonitorArguments("/release", f.file),
      monitorArguments("/release", f.file, value),
    );
    assert.deepEqual(await readFile(f.file), bytes);
  }
});
test("monitor entry sanitizes invalid JSON, UTF-8 and oversize descriptor failures", async (t) => {
  const f = await fixture(t);
  for (const body of [
    Buffer.from("SYNTHETIC_PRIVATE_DIAGNOSTIC"),
    Buffer.from([0xff]),
    Buffer.alloc(262145, 32),
  ]) {
    await writeFile(f.file, body, { mode: 0o600 });
    await assert.rejects(
      readMonitorArguments("/release", f.file),
      (error) => error.message === "MONITOR_DESCRIPTOR_REFUSED",
    );
  }
});
test("monitor entry refuses group/world-readable or non-file descriptors", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, '{"format":1}', { mode: 0o600 });
  await chmod(f.file, 0o644);
  await assert.rejects(
    readMonitorArguments("/release", f.file),
    /DESCRIPTOR_REFUSED/,
  );
  await assert.rejects(
    readMonitorArguments("/release", f.directory),
    /DESCRIPTOR_REFUSED/,
  );
  await assert.rejects(
    readMonitorArguments("/release", join(f.directory, "missing")),
    /DESCRIPTOR_REFUSED/,
  );
});

for (const [variant, descriptor, target, args] of [
  ["legacy", { format: 1 }, "tools/operations/monitor.mjs", ["--watch"]],
  [
    "durable",
    { schemaVersion: 1, mode: "monitor-only" },
    "tools/ops/monitor-service.mjs",
    [],
  ],
])
  test(`monitor entry actual installer routes ${variant} descriptor to the selected child`, async (t) => {
    const f = await fixture(t),
      bundle = join(f.directory, "bundle"),
      prefix = join(f.directory, "installed");
    await mkdir(join(bundle, "tools/install/templates"), { recursive: true });
    await mkdir(join(bundle, "runtime/bin"), { recursive: true });
    await mkdir(join(bundle, "runtime/web/apps/web/.next"), {
      recursive: true,
    });
    const files = {};
    async function member(path, body, mode = 0o644) {
      await mkdir(dirname(join(bundle, path)), { recursive: true });
      await writeFile(join(bundle, path), body, { mode });
      files[path] = createHash("sha256").update(body).digest("hex");
    }
    for (const name of [
      "artfi.mjs",
      "monitor-entry.mjs",
      "config.mjs",
      "process-info.mjs",
      "templates/artfi.service.in",
    ])
      await member("tools/install/" + name, await readFile(join(source, name)));
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    await member(
      "runtime/bin/node",
      "#!/bin/sh\n# TEST_ONLY forwards to the existing test Node; not a delivered runtime.\nexec " +
        quote(process.execPath) +
        ' --permission --allow-fs-read=* "$@"\n',
      0o755,
    );
    await member(
      target,
      "console.log(JSON.stringify({TEST_ONLY_ENTRY:" +
        JSON.stringify(variant) +
        ",args:process.argv.slice(2)}));\n",
    );
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({
        format: 1,
        release: "monitor-test-release",
        source: { revision: "0".repeat(40), fingerprint: "0".repeat(64) },
        files,
        links: {},
      }),
    );
    await writeFile(f.file, JSON.stringify(descriptor), { mode: 0o600 });
    const settings = join(f.directory, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        ARTFI_MONITOR_ENABLED: "true",
        ARTFI_MONITOR_CONFIG_FILE: f.file,
      }),
      { mode: 0o600 },
    );
    const cli = (...options) =>
      spawnSync(
        process.execPath,
        [
          join(bundle, "tools/install/artfi.mjs"),
          ...options,
          "--prefix",
          prefix,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
    for (const options of [
      ["configure", "--input", settings],
      ["install"],
      ["activate", "--release", "monitor-test-release"],
    ]) {
      const result = cli(...options);
      assert.equal(result.status, 0, result.stderr);
    }
    const result = cli("run", "--service", "monitor");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      TEST_ONLY_ENTRY: variant,
      args: [f.file, ...args],
    });
  });
