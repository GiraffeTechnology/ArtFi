import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  buildReceiptOperatorSidecar,
  inspectReceiptSidecarSource,
  inventoryReceiptSidecar,
  SIDECAR_SOURCE_FILES,
} from "../install/build-receipt-operator-sidecar.mjs";

// These fixtures are synthetic package trees, never live application/runtime inputs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture(t, { cycle = false, optional = false } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "artfi-sidecar-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sourceRoot = join(temporary, "source"),
    output = join(temporary, "sidecar");
  await mkdir(sourceRoot);
  for (const path of SIDECAR_SOURCE_FILES) {
    await mkdir(dirname(join(sourceRoot, path)), { recursive: true });
    let body = `Synthetic fixture: ${path}\n`;
    if (
      path.endsWith("bundle-node-package.mjs") ||
      path.endsWith("build-receipt-operator-sidecar.mjs")
    )
      body = await readFile(join(root, path), "utf8");
    if (path === "apps/web/package.json")
      body = JSON.stringify({
        dependencies: { ethers: "6.17.0", "unrelated-app-package": "1.0.0" },
      });
    await writeFile(join(sourceRoot, path), body);
  }
  await writeFile(join(sourceRoot, ".gitignore"), "node_modules/\n");
  const ethers = join(
    sourceRoot,
    "node_modules/.pnpm/ethers@6.17.0/node_modules/ethers",
  );
  const child = join(
    sourceRoot,
    "node_modules/.pnpm/example-dependency@1.0.0/node_modules/example-dependency",
  );
  async function pkg(path, data) {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ ...data, main: "index.cjs", license: "MIT" }),
    );
    await writeFile(
      join(path, "index.cjs"),
      "throw new Error('Packaging must never execute the fixture package');\n",
    );
    await writeFile(
      join(path, "LICENSE"),
      "Synthetic fixture notice, not a third-party license declaration\n",
    );
  }
  await pkg(ethers, {
    name: "ethers",
    version: "6.17.0",
    dependencies: { "example-dependency": "1.0.0" },
    ...(optional ? { optionalDependencies: { "not-installed": "1.0.0" } } : {}),
  });
  await pkg(child, {
    name: "example-dependency",
    version: "1.0.0",
    ...(cycle ? { dependencies: { ethers: "6.17.0" } } : {}),
  });
  await mkdir(join(sourceRoot, "apps/web/node_modules"), { recursive: true });
  await symlink(ethers, join(sourceRoot, "apps/web/node_modules/ethers"));
  await mkdir(join(ethers, "node_modules"));
  await symlink(child, join(ethers, "node_modules/example-dependency"));
  if (cycle) {
    await mkdir(join(child, "node_modules"));
    await symlink(ethers, join(child, "node_modules/ethers"));
  }
  function git(args) {
    return execFileSync("git", ["-C", sourceRoot, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: "pipe",
    })
      .toString()
      .trim();
  }
  git(["init"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=Synthetic Test",
    "-c",
    "user.email=synthetic@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Synthetic sidecar test source",
  ]);
  return {
    sourceRoot,
    output,
    ethers,
    child,
    temporary,
    git,
    selection: await inspectReceiptSidecarSource(sourceRoot),
  };
}
const build = (f) =>
  buildReceiptOperatorSidecar({
    sourceRoot: f.sourceRoot,
    output: f.output,
    selection: f.selection,
  });

test("copies the selected tools and only the installed ethers graph without executing packages", async (t) => {
  const f = await fixture(t),
    before = f.git(["status", "--porcelain"]);
  const result = await build(f);
  assert.equal(result.status, "PACKAGED_NOT_ACCEPTED");
  const manifest = JSON.parse(
    await readFile(join(f.output, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.dependencies.packages.length, 2);
  assert.equal(manifest.toolsExecuted, false);
  assert.equal(manifest.authorization, "NOT_ESTABLISHED");
  assert.equal(manifest.wholeProductAccepted, false);
  assert.equal(manifest.runtime.bundled, false);
  assert.deepEqual(manifest.source, f.selection);
  assert.deepEqual(
    await inventoryReceiptSidecar(join(f.output, "engineering-source")),
    manifest.payload,
  );
  assert.equal(f.git(["status", "--porcelain"]), before);
  assert.equal(
    Object.keys(manifest.payload.files).some((p) =>
      p.includes("unrelated-app-package"),
    ),
    false,
  );
  assert.equal(
    Object.keys(manifest.payload.files).some((p) => p.endsWith("/bin/node")),
    false,
  );
});
test("copies dependency cycles into internal relative links", async (t) => {
  const f = await fixture(t, { cycle: true });
  await build(f);
  const manifest = JSON.parse(
    await readFile(join(f.output, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.copiedPackages.length, 2);
  assert.ok(
    Object.keys(manifest.payload.links).some(
      (p) => p.includes(".store/") && p.endsWith("/node_modules/ethers"),
    ),
  );
});
test("records an absent optional dependency without installing it", async (t) => {
  const f = await fixture(t, { optional: true });
  await build(f);
  const manifest = JSON.parse(
    await readFile(join(f.output, "manifest.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.dependencies.packages.find((p) => p.name === "ethers")
      .missingOptional,
    ["not-installed"],
  );
});
test("refuses an existing output and preserves its marker", async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  await writeFile(join(f.output, "keep"), "preserve");
  await assert.rejects(build(f), { code: "EEXIST" });
  assert.equal(await readFile(join(f.output, "keep"), "utf8"), "preserve");
  assert.deepEqual(await readdir(f.output), ["keep"]);
});
test("refuses output beneath the input repository", async (t) => {
  const f = await fixture(t);
  f.output = join(f.sourceRoot, "new-output");
  await assert.rejects(build(f), /outside/);
});
test("refuses a symlink output parent", async (t) => {
  const f = await fixture(t),
    link = join(f.temporary, "linked");
  await symlink(f.temporary, link);
  f.output = join(link, "new-output");
  await assert.rejects(build(f), /physical/);
});
test("refuses dirty submitted source instead of incorporating an unselected repair", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.sourceRoot, "scripts/release/prepare-isolated-hoodi-charity.mjs"),
    "changed\n",
  );
  await assert.rejects(build(f), /clean/);
});
test("refuses an unrelated untracked source file", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, "untracked"), "untracked\n");
  await assert.rejects(build(f), /clean/);
});
test("refuses a different selected commit", async (t) => {
  const f = await fixture(t);
  f.selection.revision = "1".repeat(40);
  await assert.rejects(build(f), /identity changed/);
});
test("refuses a selected source byte mismatch", async (t) => {
  const f = await fixture(t);
  f.selection.files["LICENSE"].sha256 = "1".repeat(64);
  await assert.rejects(build(f), /source file changed/);
});
test("refuses missing, extra or malformed selection entries", async (t) => {
  const f = await fixture(t),
    original = structuredClone(f.selection);
  delete f.selection.files["LICENSE"];
  await assert.rejects(build(f), /inventory fields/);
  f.selection = structuredClone(original);
  f.selection.authorization = "approved";
  await assert.rejects(build(f), /selection fields/);
  f.selection = structuredClone(original);
  f.selection.files["LICENSE"].bytes = -1;
  await assert.rejects(build(f), /file identity/);
});
test("refuses changed installed dependency bytes even though Git still reads clean", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.child, "index.cjs"), "changed dependency\n");
  assert.equal(f.git(["status", "--porcelain"]), "");
  await assert.rejects(build(f), /identity changed/);
});
test("refuses an installed ethers version different from the selected source", async (t) => {
  const f = await fixture(t),
    p = join(f.ethers, "package.json");
  const data = JSON.parse(await readFile(p, "utf8"));
  data.version = "6.16.0";
  await writeFile(p, JSON.stringify(data));
  await assert.rejects(build(f), /version mismatch/);
});
test("refuses an absent required dependency", async (t) => {
  const f = await fixture(t);
  await rm(join(f.ethers, "node_modules/example-dependency"));
  await assert.rejects(build(f), /Missing installed dependency/);
});
test("refuses dependency files with credential-style names before copying", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.child, ".env"), "SYNTHETIC_TEST_ONLY\n");
  await assert.rejects(build(f), /Sensitive dependency/);
  await assert.rejects(readFile(join(f.output, "manifest.json")), {
    code: "ENOENT",
  });
});
test("refuses a package without a distributable notice", async (t) => {
  const f = await fixture(t);
  await rm(join(f.child, "LICENSE"));
  await assert.rejects(build(f), /Missing dependency notice/);
});
test("refuses symlinks inside dependency source files", async (t) => {
  const f = await fixture(t);
  await symlink(join(f.child, "index.cjs"), join(f.child, "linked.cjs"));
  await assert.rejects(build(f), /symlink refused/);
});
test("refuses a dependency graph that resolves outside the selected source", async (t) => {
  const f = await fixture(t),
    external = join(f.temporary, "external");
  await mkdir(external);
  await writeFile(
    join(external, "package.json"),
    JSON.stringify({ name: "example-dependency", version: "1.0.0" }),
  );
  await rm(join(f.ethers, "node_modules/example-dependency"));
  await symlink(external, join(f.ethers, "node_modules/example-dependency"));
  await assert.rejects(build(f), /outside selected source/);
});
test("refuses payload symlinks that escape the output", async (t) => {
  const f = await fixture(t),
    external = join(f.temporary, "outside");
  await mkdir(f.output);
  await writeFile(external, "synthetic");
  await symlink(external, join(f.output, "link"));
  await assert.rejects(inventoryReceiptSidecar(f.output), /escapes payload/);
});
test("permits field reordering in an otherwise exact selection", async (t) => {
  const f = await fixture(t);
  f.selection.files["LICENSE"] = {
    sha256: f.selection.files["LICENSE"].sha256,
    bytes: f.selection.files["LICENSE"].bytes,
  };
  assert.equal((await build(f)).status, "PACKAGED_NOT_ACCEPTED");
});
