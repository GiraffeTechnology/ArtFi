import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { bundleNodePackage } from "./bundle-node-package.mjs";
test("application package export includes only declared runtime roots and their dependencies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artfi-node-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "app"),
    dest = join(root, "bundle");
  await mkdir(join(src, "src"), { recursive: true });
  await mkdir(join(src, "node_modules/example-package"), { recursive: true });
  await writeFile(
    join(src, "package.json"),
    JSON.stringify({
      name: "test-only-app",
      dependencies: { "example-package": "1.0.0" },
    }),
  );
  await writeFile(join(src, "src/server.mjs"), "export const ready=true;");
  await writeFile(join(src, ".env.local"), "TEST_ONLY_NOT_FOR_THE_ARTIFACT=1");
  await writeFile(
    join(src, "operator-settings.json"),
    '{"TEST_ONLY":"private local settings"}',
  );
  await writeFile(
    join(src, "node_modules/example-package/package.json"),
    JSON.stringify({
      name: "example-package",
      version: "1.0.0",
      main: "index.js",
    }),
  );
  await writeFile(
    join(src, "node_modules/example-package/index.js"),
    "module.exports=1;",
  );
  await bundleNodePackage(src, dest, ["src", "package.json"]);
  assert.match(await readFile(join(dest, "src/server.mjs"), "utf8"), /ready/);
  await assert.rejects(access(join(dest, ".env.local")));
  await assert.rejects(access(join(dest, "operator-settings.json")));
  assert.match(
    await readFile(join(dest, "node_modules/example-package/index.js"), "utf8"),
    /exports/,
  );
});

test("scoped dependency ESM subpackages retain ordinary self-name imports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artfi-node-self-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = join(root, "app"),
    dest = join(root, "bundle");
  await mkdir(join(src, "src"), { recursive: true });
  const dependency = join(src, "node_modules/@fixture/hashes");
  await mkdir(join(dependency, "esm"), { recursive: true });
  await writeFile(
    join(src, "package.json"),
    JSON.stringify({
      name: "test-only-app",
      type: "module",
      dependencies: { "@fixture/hashes": "1.0.0" },
    }),
  );
  await writeFile(
    join(src, "src/server.mjs"),
    'export { proof } from "@fixture/hashes";',
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "@fixture/hashes",
      version: "1.0.0",
      exports: { ".": "./esm/index.js", "./crypto": "./esm/crypto.js" },
    }),
  );
  await writeFile(join(dependency, "esm/package.json"), '{"type":"module"}');
  await writeFile(
    join(dependency, "esm/index.js"),
    'export { proof } from "@fixture/hashes/crypto";',
  );
  await writeFile(
    join(dependency, "esm/crypto.js"),
    'export const proof = "SELF_IMPORT_RESOLVED";',
  );
  await bundleNodePackage(src, dest, ["src", "package.json"]);
  assert.equal(
    (await import(pathToFileURL(join(dest, "src/server.mjs")).href)).proof,
    "SELF_IMPORT_RESOLVED",
  );
});
