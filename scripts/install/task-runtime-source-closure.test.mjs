import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  mkdir,
  symlink,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { emitTaskRuntimeSources } from "./emit-task-runtime-sources.mjs";

const root = process.env.ARTFI_RUNTIME_SOURCE_ROOT;
const original = process.env.ARTFI_RUNTIME_ORIGINAL_WEB;
const require = createRequire(join(original, "package.json"));
const ts = require("typescript");
const template = JSON.parse(
  await readFile(join(root, "scripts/task-runtime/package.json"), "utf8"),
);
const temporary = await mkdtemp(join(tmpdir(), "artfi-source-emitter-"));
let emitted;
test("real compiler emits the complete current task-runtime source closure", async () => {
  assert.equal(ts.version, "5.9.3");
  const versionBindings = {};
  for (const name of [
    ...Object.keys(template.dependencies).filter(
      (name) => name !== "server-only",
    ),
    "next",
  ])
    versionBindings[name] = JSON.parse(
      await readFile(
        join(original, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version;
  console.log(
    "ACTUAL_EXISTING_DEPENDENCY_VERSIONS",
    JSON.stringify(versionBindings),
  );
  assert.equal(
    template.dependencies.zod,
    JSON.parse(await readFile(join(root, "apps/web/package.json"), "utf8"))
      .dependencies.zod,
  );
  emitted = await emitTaskRuntimeSources({
    root,
    destination: join(temporary, "emitted"),
    typescript: ts,
    dependencies: template.dependencies,
  });
  assert.equal(emitted.sourceOnly, true);
  assert.equal(emitted.installationAcceptance, "NOT_ESTABLISHED");
  for (const p of [
    "apps/web/src/lib/whole-receipt-journal-composition.ts",
    "apps/web/src/lib/whole-receipt-prepared-journal.ts",
    "apps/web/src/lib/nft/task-journal.ts",
    "scripts/task-runtime/server.mjs",
  ]) {
    assert.equal(
      emitted.sourceFiles[p],
      createHash("sha256")
        .update(await readFile(join(root, p)))
        .digest("hex"),
    );
    assert.ok(
      (await readFile(join(temporary, "emitted", p.replace(/\.ts$/, ".js"))))
        .length > 0,
    );
  }
  assert.ok(
    !Object.keys(emitted.sourceFiles).some((p) => p.includes("node_modules")),
  );
});
test("emitted runtime loads in a fresh native Node process with real dependencies and marker", async () => {
  assert.ok(emitted);
  const destination = join(temporary, "emitted");
  await writeFile(
    join(destination, "package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  for (const name of Object.keys(template.dependencies)) {
    const source =
      name === "server-only"
        ? join(
            dirname(require.resolve("next/package.json")),
            "dist/compiled/server-only",
          )
        : join(original, "node_modules", name);
    const target = join(destination, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, "dir");
  }
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    ARTFI_TEST_NETWORK_GUARD_LOG: process.env.ARTFI_TEST_NETWORK_GUARD_LOG,
  };
  const code = `import assert from 'node:assert/strict'; const runtime=await import('./scripts/task-runtime/server.mjs'); for(const name of ['createWholeReceiptNativeJournal','createNativeNftTaskPort','createNftTaskJournal','createListedOrderObserver'])assert.equal(typeof runtime[name],'function',name);`;
  const actual = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--input-type=module", "-e", code],
    { cwd: destination, env, encoding: "utf8", timeout: 20000 },
  );
  assert.equal(actual.status, 0, actual.stderr || String(actual.error));
});
test("does not overwrite a previous emission directory", async () => {
  const destination = join(temporary, "exists");
  await mkdir(destination);
  await writeFile(join(destination, "sentinel"), "preserve");
  await assert.rejects(
    emitTaskRuntimeSources({
      root,
      destination,
      typescript: ts,
      dependencies: template.dependencies,
    }),
    /EEXIST/,
  );
  assert.equal(
    await readFile(join(destination, "sentinel"), "utf8"),
    "preserve",
  );
});
test("refuses an undeclared source dependency without widening package declarations", async () => {
  await assert.rejects(
    emitTaskRuntimeSources({
      root,
      destination: join(temporary, "undeclared"),
      typescript: ts,
      dependencies: {},
    }),
    /Undeclared runtime dependency/,
  );
});
test("refuses missing actual entry source", async () => {
  const missing = join(temporary, "missing-root");
  await mkdir(missing);
  await assert.rejects(
    emitTaskRuntimeSources({
      root: missing,
      destination: join(temporary, "missing-output"),
      typescript: ts,
      dependencies: template.dependencies,
    }),
    /ENOENT/,
  );
});
test("source emission does not create package manifests, bundled dependencies, or claim installation", async () => {
  const files = await readdir(join(temporary, "emitted"));
  assert.ok(!files.includes("runtime-manifest.json"));
  assert.ok(!files.some((p) => p.endsWith(".tgz")));
  assert.equal(emitted.installationAcceptance, "NOT_ESTABLISHED");
});
