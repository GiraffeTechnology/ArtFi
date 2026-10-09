import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = dirname(fileURLToPath(import.meta.url));
async function fixture({ nodeStub = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "artfi-installer-test-")),
    bundle = join(directory, "bundle"),
    prefix = join(directory, "installed");
  await mkdir(join(bundle, "tools/install/templates"), { recursive: true });
  await mkdir(join(bundle, "runtime/web/apps/web/.next"), { recursive: true });
  const files = {};
  for (const name of [
    "artfi.mjs",
    "config.mjs",
    "process-info.mjs",
    "templates/artfi.service.in",
  ]) {
    const body = await readFile(join(source, name));
    await writeFile(join(bundle, "tools/install", name), body);
    files[`tools/install/${name}`] = createHash("sha256")
      .update(body)
      .digest("hex");
  }
  if (nodeStub) {
    await mkdir(join(bundle, "runtime/bin"), { recursive: true });
    const body =
      "#!/bin/sh\n# TEST_ONLY executable for offline unit parsing; never started.\nexit 0\n";
    await writeFile(join(bundle, "runtime/bin/node"), body, { mode: 0o755 });
    files["runtime/bin/node"] = createHash("sha256").update(body).digest("hex");
  }
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify({
      format: 1,
      release: "test-release",
      source: { revision: "0".repeat(40), fingerprint: "0".repeat(64) },
      files,
      links: {},
    }),
  );
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [join(bundle, "tools/install/artfi.mjs"), ...args, "--prefix", prefix],
      { encoding: "utf8" },
    );
  return { directory, bundle, prefix, cli };
}

test("isolated install preserves private config and requires explicit activation", async () => {
  const f = await fixture();
  try {
    assert.equal(f.cli("check-bundle").status, 0);
    assert.equal(f.cli("configure").status, 0);
    const configFile = join(f.prefix, "shared/config.json"),
      original = await readFile(configFile, "utf8");
    assert.equal((await lstat(configFile)).mode & 0o777, 0o600);
    assert.equal(f.cli("install").status, 0);
    await assert.rejects(lstat(join(f.prefix, "current")));
    assert.equal(f.cli("activate", "--release", "test-release").status, 0);
    assert.equal(
      await readlink(join(f.prefix, "current")),
      "releases/test-release",
    );
    assert.equal(f.cli("install").status, 0);
    assert.equal(f.cli("configure").status, 0);
    assert.equal(await readFile(configFile, "utf8"), original);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("modified files and unlisted executable content are rejected", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.bundle, "extra.js"), "malicious");
    assert.notEqual(f.cli("check-bundle").status, 0);
    await rm(join(f.bundle, "extra.js"));
    await writeFile(
      join(f.bundle, "tools/install/config.mjs"),
      (await readFile(join(source, "config.mjs"), "utf8")) + "\n// changed\n",
    );
    assert.notEqual(f.cli("check-bundle").status, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("release symlinks must resolve inside the artifact", async () => {
  const f = await fixture();
  try {
    const path = join(f.bundle, "manifest.json"),
      manifest = JSON.parse(await readFile(path, "utf8"));
    await symlink(source, join(f.bundle, "outside"));
    manifest.links = { outside: source };
    await writeFile(path, JSON.stringify(manifest));
    assert.notEqual(f.cli("check-bundle").status, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("installation preserves internal dependency symlinks", async () => {
  const f = await fixture();
  try {
    const manifestFile = join(f.bundle, "manifest.json"),
      manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    await symlink("tools/install/config.mjs", join(f.bundle, "internal-link"));
    manifest.links = { "internal-link": "tools/install/config.mjs" };
    await writeFile(manifestFile, JSON.stringify(manifest));
    assert.equal(f.cli("configure").status, 0);
    const result = f.cli("install");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readlink(join(f.prefix, "releases/test-release/internal-link")),
      "tools/install/config.mjs",
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("private configuration cannot be written inside the distributable bundle", async () => {
  const f = await fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(f.bundle, "tools/install/artfi.mjs"),
        "configure",
        "--prefix",
        join(f.bundle, "installation"),
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the extracted bundle/);
    assert.equal(f.cli("check-bundle").status, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("dot-prefixed and symlinked destinations cannot put private configuration in an artifact", async () => {
  const f = await fixture();
  try {
    const link = join(f.directory, "bundle-alias");
    await symlink(f.bundle, link);
    for (const destination of [
      join(f.bundle, "..private"),
      join(link, "private"),
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          join(f.bundle, "tools/install/artfi.mjs"),
          "configure",
          "--prefix",
          destination,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /outside the extracted bundle/);
      assert.equal(f.cli("check-bundle").status, 0);
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("control characters cannot inject service-unit directives through installation paths", async () => {
  const result = spawnSync(
    process.execPath,
    [
      join(source, "artfi.mjs"),
      "configure",
      "--prefix",
      "/tmp/artfi-invalid\nExecStart=unexpected",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not contain control characters/);
});

test("generated service units keep literal dollar and percent characters in paths", async () => {
  const f = await fixture();
  try {
    const prefix = join(f.directory, "installed-${USER}-50%"),
      output = join(f.directory, "units");
    for (const args of [
      ["configure"],
      ["install"],
      ["activate", "--release", "test-release"],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          join(f.bundle, "tools/install/artfi.mjs"),
          ...args,
          "--prefix",
          prefix,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const result = spawnSync(
      process.execPath,
      [
        join(f.bundle, "tools/install/artfi.mjs"),
        "service-units",
        "--prefix",
        prefix,
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const body = await readFile(join(output, "artfi-web.service"), "utf8");
    assert.ok(
      body.includes(`WorkingDirectory=${prefix.replaceAll("%", "%%")}/.`),
    );
    assert.match(
      body,
      /^ExecStart=:".*installed-\$\{USER\}-50%%\/current\/runtime\/bin\/node"/m,
    );
    assert.ok(
      body.includes(
        '--prefix "' + prefix.replaceAll("%", "%%") + '" --service web',
      ),
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("all user service units parse with spaces, percent and terminal whitespace", async (t) => {
  if (spawnSync("systemd-analyze", ["--version"]).status !== 0) {
    t.skip("systemd-analyze unavailable; actual user-unit parse not run");
    return;
  }
  const f = await fixture({ nodeStub: true });
  try {
    const runtime = join(f.directory, "private-runtime");
    await mkdir(runtime, { mode: 0o700 });
    for (const [index, suffix] of [
      " space ${USER}-50%",
      " semicolon; hash#",
      " terminal space ",
    ].entries()) {
      const prefix = join(f.directory, `installed-${index}${suffix}`),
        output = join(f.directory, `units-${index}`);
      for (const args of [
        ["configure"],
        ["install"],
        ["activate", "--release", "test-release"],
        ["service-units", "--output", output],
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            join(f.bundle, "tools/install/artfi.mjs"),
            ...args,
            "--prefix",
            prefix,
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      const units = ["api", "web", "mirror", "agent", "monitor"].map((name) =>
        join(output, `artfi-${name}.service`),
      );
      const result = spawnSync(
        "systemd-analyze",
        ["--user", "verify", ...units],
        { env: { ...process.env, XDG_RUNTIME_DIR: runtime }, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("unit generation reports systemd's unsupported executable-path characters", async () => {
  const f = await fixture({ nodeStub: true });
  try {
    for (const suffix of ['quote"', "quote'", "backslash\\"]) {
      const prefix = join(f.directory, `installed-${suffix}`);
      for (const args of [
        ["configure"],
        ["install"],
        ["activate", "--release", "test-release"],
      ]) {
        const result = spawnSync(
          process.execPath,
          [
            join(f.bundle, "tools/install/artfi.mjs"),
            ...args,
            "--prefix",
            prefix,
          ],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
      }
      const result = spawnSync(
        process.execPath,
        [
          join(f.bundle, "tools/install/artfi.mjs"),
          "service-units",
          "--prefix",
          prefix,
        ],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /without quotes or backslashes/);
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
