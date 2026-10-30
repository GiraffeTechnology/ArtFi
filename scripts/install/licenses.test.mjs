import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { copyProjectNotices, PROJECT_NOTICE_FILES } from "./licenses.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function inventory(directory, base = directory, files = {}) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, item.name);
    if (item.isDirectory()) await inventory(file, base, files);
    else files[file.slice(base.length + 1)] = hash(await readFile(file));
  }
  return files;
}

test("project notices are fixed, complete, and copied without changing their bytes", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "artfi-notices-"));
  try {
    await copyProjectNotices(root, temporary);
    const files = await inventory(temporary);
    assert.deepEqual(
      Object.keys(files).sort(),
      PROJECT_NOTICE_FILES.map(([, file]) => file).sort(),
    );
    for (const [source, destination] of PROJECT_NOTICE_FILES)
      assert.equal(
        files[destination],
        hash(await readFile(join(root, source))),
      );
    const build = await readFile(
      join(root, "scripts/install/build-bundle.mjs"),
      "utf8",
    );
    assert.match(build, /await copyProjectNotices\(root, bundle\)/);
    assert.ok(
      build.indexOf("await copyProjectNotices(root, bundle)") <
        build.indexOf("const { files, links } = await inventory(bundle)"),
    );
    assert.match(
      await readFile(join(temporary, "LICENSE"), "utf8"),
      /does not revoke, narrow, or add conditions to valid prior grants/,
    );
    assert.match(
      await readFile(
        join(temporary, "licenses/fonts/INTER-LICENSE.txt"),
        "utf8",
      ),
      /Copyright \(c\) 2016 The Inter Project Authors/,
    );
    assert.match(
      await readFile(join(temporary, "LICENSES/MIT.txt"), "utf8"),
      /Permission is hereby granted, free of charge/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("installable tar and installer preserve and verify every notice", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "artfi-notice-install-"));
  try {
    const bundle = join(temporary, "bundle"),
      extracted = join(temporary, "extracted"),
      prefix = join(temporary, "installed");
    await copyProjectNotices(root, bundle);
    await mkdir(join(bundle, "tools/install/templates"), { recursive: true });
    await mkdir(join(bundle, "runtime/web/apps/web/.next"), {
      recursive: true,
    });
    for (const file of [
      "artfi.mjs",
      "config.mjs",
      "process-info.mjs",
      "templates/artfi.service.in",
    ])
      await cp(
        join(root, "scripts/install", file),
        join(bundle, "tools/install", file),
      );
    const files = await inventory(bundle);
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({
        format: 1,
        release: "notice-test",
        source: { revision: "0".repeat(40), fingerprint: "0".repeat(64) },
        files,
        links: {},
      }),
    );
    const archive = join(temporary, "bundle.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
    await mkdir(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const cli = (command) =>
      execFileSync(
        process.execPath,
        [
          join(extracted, "tools/install/artfi.mjs"),
          command,
          "--prefix",
          prefix,
        ],
        { encoding: "utf8" },
      );
    cli("check-bundle");
    cli("configure");
    cli("install");
    for (const [source, destination] of PROJECT_NOTICE_FILES) {
      const expected = await readFile(join(root, source));
      assert.deepEqual(await readFile(join(extracted, destination)), expected);
      assert.deepEqual(
        await readFile(join(prefix, "releases/notice-test", destination)),
        expected,
      );
      assert.equal(files[destination], hash(expected));
    }
    await writeFile(join(extracted, "NOTICE"), "changed");
    assert.throws(() => cli("check-bundle"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("missing legal files fail rather than silently produce an incomplete bundle", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "artfi-notice-missing-"));
  try {
    await assert.rejects(
      copyProjectNotices(temporary, join(temporary, "bundle")),
      /ENOENT/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("package metadata preserves private and separately licensed contract scope", async () => {
  for (const file of [
    "package.json",
    "apps/agent-runtime/package.json",
    "apps/market-mirror/package.json",
    "apps/wallet-extension/package.json",
    "apps/web/package.json",
    "packages/api-client/package.json",
    "packages/contracts/package.json",
  ]) {
    const manifest = JSON.parse(await readFile(join(root, file), "utf8"));
    assert.equal(manifest.private, true);
    assert.equal(
      manifest.license,
      file === "package.json"
        ? "SEE LICENSE IN LICENSE"
        : file === "packages/contracts/package.json"
          ? "MIT"
          : "UNLICENSED",
    );
  }
  for (const folder of ["src", "script", "test"]) {
    for (const file of await readdir(
      join(root, "packages/contracts", folder),
    )) {
      if (file.endsWith(".sol"))
        assert.match(
          await readFile(
            join(root, "packages/contracts", folder, file),
            "utf8",
          ),
          /^\/\/ SPDX-License-Identifier: MIT\n/,
        );
    }
  }
});
