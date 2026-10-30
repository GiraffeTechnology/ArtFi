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
  readdir,
  rename,
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

test("missing install configuration is actionable and leaves no staged state", async () => {
  const f = await fixture();
  try {
    const result = f.cli("install");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not found.*--config or --input/);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(f.prefix));
    await assert.rejects(lstat(f.prefix));
    assert.equal(f.cli("check-bundle").status, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("install and validate keep malformed configuration contents out of logs", async () => {
  const f = await fixture();
  try {
    const shared = join(f.prefix, "shared");
    const path = join(shared, "config.json");
    await mkdir(shared, { recursive: true });
    await writeFile(path, "LEAKVALUE", { mode: 0o600 });
    for (const command of ["install", "validate"]) {
      const result = f.cli(command);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must contain valid JSON/);
      assert.ok(!result.stderr.includes("LEAKVALUE"));
      assert.equal(result.stdout, "");
      assert.equal(await readFile(path, "utf8"), "LEAKVALUE");
    }
    assert.deepEqual(await readdir(shared), ["config.json"]);
    await assert.rejects(lstat(join(f.prefix, "releases")));
    assert.equal(f.cli("check-bundle").status, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("malformed configure input preserves the existing private configuration", async () => {
  const f = await fixture();
  try {
    assert.equal(f.cli("configure").status, 0);
    const path = join(f.prefix, "shared/config.json");
    const original = await readFile(path, "utf8");
    const input = join(f.directory, "input.json");
    await writeFile(input, "LEAKVALUE", { mode: 0o600 });
    const result = f.cli("configure", "--input", input);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must contain valid JSON/);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("LEAKVALUE"));
    for (const value of Object.values(JSON.parse(original)))
      if (typeof value === "string" && value.length >= 32)
        assert.ok(!result.stderr.includes(value));
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(await readdir(join(f.prefix, "shared")), ["config.json"]);
    await assert.rejects(lstat(join(f.prefix, "releases")));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

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

// TEST_ONLY fixtures never connect to a database or start an application service.
async function installerTreeSnapshot(directory) {
  const rows = [];
  async function walk(path, name) {
    const info = await lstat(path);
    const row = { name, mode: info.mode & 0o777 };
    if (info.isSymbolicLink()) row.link = await readlink(path);
    else if (info.isDirectory()) {
      row.directory = true;
      rows.push(row);
      for (const child of (await readdir(path)).sort())
        await walk(join(path, child), name ? `${name}/${child}` : child);
      return;
    } else
      row.sha256 = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    rows.push(row);
  }
  await walk(directory, "");
  return rows;
}
async function nextFixtureRelease(f) {
  const file = join(f.bundle, "manifest.json");
  const value = JSON.parse(await readFile(file, "utf8"));
  value.release = "next-release";
  await writeFile(file, JSON.stringify(value));
}
async function managedFixture(f) {
  for (const args of [
    ["configure"],
    ["install"],
    ["activate", "--release", "test-release"],
  ]) {
    const result = f.cli(...args);
    assert.equal(result.status, 0, result.stderr);
  }
}

for (const variant of [
  "missing-prefix",
  "configured-only",
  "regular-current",
  "external-current",
  "traversing-current",
]) {
  test(`upgrade refuses ${variant} without changing any fixture file`, async () => {
    const f = await fixture();
    try {
      if (variant !== "missing-prefix")
        assert.equal(f.cli("configure").status, 0);
      if (variant === "regular-current")
        await writeFile(join(f.prefix, "current"), "releases/test-release");
      if (variant === "external-current")
        await symlink(f.bundle, join(f.prefix, "current"));
      if (variant === "traversing-current")
        await symlink("releases/../outside", join(f.prefix, "current"));
      const before = await installerTreeSnapshot(f.directory);
      const result = f.cli("upgrade");
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /existing managed active release/);
      assert.deepEqual(await installerTreeSnapshot(f.directory), before);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

for (const variant of [
  "damaged-current",
  "manifest-directory-mismatch",
  "linked-releases",
  "linked-release",
  "release-override",
]) {
  test(`upgrade refuses ${variant} before candidate staging or service changes`, async () => {
    const f = await fixture();
    try {
      await managedFixture(f);
      const active = join(f.prefix, "releases/test-release");
      if (variant === "damaged-current")
        await writeFile(
          join(active, "tools/install/config.mjs"),
          "TEST_ONLY damaged bytes",
        );
      if (variant === "manifest-directory-mismatch") {
        const file = join(active, "manifest.json");
        const value = JSON.parse(await readFile(file, "utf8"));
        value.release = "different-release";
        await writeFile(file, JSON.stringify(value));
      }
      if (variant === "linked-releases") {
        const destination = join(f.directory, "retained-releases");
        await rename(join(f.prefix, "releases"), destination);
        await symlink(destination, join(f.prefix, "releases"));
      }
      if (variant === "linked-release") {
        const destination = join(f.directory, "retained-active");
        await rename(active, destination);
        await symlink(destination, active);
      }
      await nextFixtureRelease(f);
      const before = await installerTreeSnapshot(f.directory);
      const result = f.cli(
        "upgrade",
        ...(variant === "release-override"
          ? ["--release", "test-release"]
          : []),
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /existing managed active release|checksum mismatch|does not match its managed directory|not an upgrade option/,
      );
      assert.deepEqual(await installerTreeSnapshot(f.directory), before);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  });
}

test("a verified managed prefix reaches ordinary candidate staging and migration-status handling", async () => {
  const f = await fixture();
  try {
    await managedFixture(f);
    const configFile = join(f.prefix, "shared/config.json");
    const settings = JSON.parse(await readFile(configFile, "utf8"));
    settings.MYSQL_DSN = "test_only@tcp(127.0.0.1:1)/not_connected";
    await writeFile(configFile, JSON.stringify(settings));
    const originalConfig = await readFile(configFile, "utf8");
    await nextFixtureRelease(f);
    await mkdir(join(f.bundle, "runtime/bin"), { recursive: true });
    const stub =
      "#!/bin/sh\nprintf 'TEST_ONLY migration status reached\\n' >&2\nexit 9\n";
    await writeFile(join(f.bundle, "runtime/bin/artfi-migrate"), stub, {
      mode: 0o755,
    });
    const manifestFile = join(f.bundle, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.files["runtime/bin/artfi-migrate"] = createHash("sha256")
      .update(stub)
      .digest("hex");
    await writeFile(manifestFile, JSON.stringify(manifest));
    const result = f.cli("upgrade");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TEST_ONLY migration status reached/);
    assert.equal(
      await readlink(join(f.prefix, "current")),
      "releases/test-release",
    );
    assert.equal(await readFile(configFile, "utf8"), originalConfig);
    assert.equal(
      JSON.parse(
        await readFile(
          join(f.prefix, "releases/next-release/manifest.json"),
          "utf8",
        ),
      ).release,
      "next-release",
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
