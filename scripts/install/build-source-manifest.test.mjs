import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertBuildSourceUnchanged,
  captureBuildSource,
} from "./build-source-manifest.mjs";

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}
async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "artfi-build-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "repo");
  await mkdir(root);
  git(root, "init", "-q");
  await writeFile(join(root, "entry.mjs"), "export const value = 1;\n");
  await chmod(join(root, "entry.mjs"), 0o644);
  git(root, "add", "entry.mjs");
  git(
    root,
    "-c",
    "user.name=ArtFi fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  return { root, parent };
}

test("binds clean Git source, bytes and mode", async (t) => {
  const { root } = await fixture(t);
  const source = await captureBuildSource(root);
  assert.equal(source.format, 2);
  assert.equal(source.revision, git(root, "rev-parse", "HEAD"));
  assert.equal(source.tree, git(root, "rev-parse", "HEAD^{tree}"));
  assert.equal(source.dirty, false);
  assert.equal(
    source.files["entry.mjs"],
    createHash("sha256")
      .update(await readFile(join(root, "entry.mjs")))
      .digest("hex"),
  );
  assert.equal(source.modes["entry.mjs"], "100644");
  assertBuildSourceUnchanged(source, await captureBuildSource(root));
});

test("refuses changed bytes on the same commit", async (t) => {
  const { root } = await fixture(t);
  const before = await captureBuildSource(root);
  await writeFile(join(root, "entry.mjs"), "export const value = 2;\n");
  const after = await captureBuildSource(root);
  assert.equal(after.revision, before.revision);
  assert.equal(after.tree, before.tree);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.throws(
    () => assertBuildSourceUnchanged(before, after),
    /Source changed/,
  );
});

test("detects modes when Git ignores file modes", async (t) => {
  const { root } = await fixture(t);
  git(root, "config", "core.filemode", "false");
  const before = await captureBuildSource(root);
  await chmod(join(root, "entry.mjs"), 0o755);
  const after = await captureBuildSource(root);
  assert.equal(after.dirty, false);
  assert.equal(after.files["entry.mjs"], before.files["entry.mjs"]);
  assert.equal(after.modes["entry.mjs"], "100755");
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.throws(
    () => assertBuildSourceUnchanged(before, after),
    /Source changed/,
  );
});

test("detects dirty-only source drift", async (t) => {
  const { root } = await fixture(t);
  await chmod(join(root, "entry.mjs"), 0o755);
  git(root, "config", "core.filemode", "false");
  const before = await captureBuildSource(root);
  git(root, "config", "core.filemode", "true");
  const after = await captureBuildSource(root);
  assert.equal(before.dirty, false);
  assert.equal(after.dirty, true);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.modes, before.modes);
  assert.throws(
    () => assertBuildSourceUnchanged(before, after),
    /Source changed/,
  );
});

test("includes untracked build inputs", async (t) => {
  const { root } = await fixture(t);
  const before = await captureBuildSource(root);
  await writeFile(join(root, "new-input.json"), "{}\n");
  const after = await captureBuildSource(root);
  assert.equal(after.dirty, true);
  assert.ok(Object.hasOwn(after.files, "new-input.json"));
  assert.throws(
    () => assertBuildSourceUnchanged(before, after),
    /Source changed/,
  );
});

test("ignores generated output", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, ".gitignore"), "output/\n");
  git(root, "add", ".gitignore");
  git(
    root,
    "-c",
    "user.name=ArtFi fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "ignore output",
  );
  const before = await captureBuildSource(root);
  await mkdir(join(root, "output"));
  await writeFile(join(root, "output", "generated.json"), "{}\n");
  const after = await captureBuildSource(root);
  assert.equal(after.dirty, false);
  assertBuildSourceUnchanged(before, after);
});

test("refuses source symlinks", async (t) => {
  const { root, parent } = await fixture(t);
  await writeFile(
    join(parent, "outside.mjs"),
    "export const outside = true;\n",
  );
  await symlink(join(parent, "outside.mjs"), join(root, "alias.mjs"));
  await assert.rejects(
    captureBuildSource(root),
    /source links are unsupported/,
  );
});

test("refuses a replaced source parent", async (t) => {
  const { root, parent } = await fixture(t);
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "input.mjs"), "original\n");
  git(root, "add", "nested/input.mjs");
  git(
    root,
    "-c",
    "user.name=ArtFi fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "nested input",
  );
  await rm(join(root, "nested"), { recursive: true });
  await mkdir(join(parent, "outside"));
  await writeFile(join(parent, "outside", "input.mjs"), "replacement\n");
  await symlink(join(parent, "outside"), join(root, "nested"));
  await assert.rejects(
    captureBuildSource(root),
    /source links are unsupported/,
  );
});

test("includes special source names", async (t) => {
  const { root } = await fixture(t);
  const before = await captureBuildSource(root);
  await writeFile(join(root, "__proto__"), "input\n");
  const after = await captureBuildSource(root);
  assert.equal(Object.getPrototypeOf(after.files), null);
  assert.equal(Object.getPrototypeOf(after.modes), null);
  assert.ok(Object.hasOwn(after.files, "__proto__"));
  assert.equal(after.modes.__proto__, "100644");
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.throws(
    () => assertBuildSourceUnchanged(before, after),
    /Source changed/,
  );
});
