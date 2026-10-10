#!/usr/bin/env node
import { bundleNodePackage } from "./bundle-node-package.mjs";
import { collectLicenses, copyProjectNotices } from "./licenses.mjs";
import { bundleContracts } from "./bundle-contracts.mjs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  lstat,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  opts = {};
for (let i = 2; i < process.argv.length; i += 2)
  opts[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const node = opts["node-binary"] || process.execPath,
  go = opts.go || "go",
  forge = opts.forge || "forge";
const nodeLicense =
  opts["node-license"] || resolve(dirname(node), "../LICENSE");
const env = { ...process.env };
for (const key of Object.keys(env))
  if (
    /^(?:ARTFI_|NEXT_PUBLIC_|OPENSEA_|MYSQL_|REDIS_|R2_|GIRAFFE_LANGUAGE_)/.test(
      key,
    )
  )
    delete env[key];
env.NEXT_TELEMETRY_DISABLED = "1";
env.CGO_ENABLED = "0";
env.GOOS = "linux";
env.GOARCH = { x64: "amd64", arm64: "arm64" }[process.arch] || "";
function run(exe, args, cwd = root) {
  const result = spawnSync(exe, args, { cwd, env, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`Build command failed: ${exe} ${args.join(" ")}`);
}
const digest = (body) => createHash("sha256").update(body).digest("hex");
async function sourceManifest() {
  const files = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: root },
    )
      .toString()
      .split("\0")
      .filter(Boolean)
      .sort(),
    hashes = {};
  for (const file of files) {
    const st = await lstat(join(root, file));
    if (st.isFile()) hashes[file] = digest(await readFile(join(root, file)));
  }
  return {
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    fingerprint: digest(JSON.stringify(hashes)),
    files: hashes,
  };
}
async function inventory(path, base = path, files = {}, links = {}) {
  for (const name of (await readdir(path)).sort()) {
    const file = join(path, name),
      rel = file.slice(base.length + 1),
      st = await lstat(file);
    if (st.isSymbolicLink()) links[rel] = await readlink(file);
    else if (st.isDirectory()) await inventory(file, base, files, links);
    else if (st.isFile()) files[rel] = digest(await readFile(file));
  }
  return { files, links };
}
try {
  if (process.platform !== "linux" || !env.GOARCH)
    throw new Error(
      "Build this native Linux artifact on supported Linux x64 or arm64.",
    );
  const suppliedNode = JSON.parse(
    execFileSync(
      node,
      [
        "-p",
        "JSON.stringify({platform:process.platform,architecture:process.arch,version:process.version})",
      ],
      { encoding: "utf8" },
    ),
  );
  if (
    suppliedNode.platform !== process.platform ||
    suppliedNode.architecture !== process.arch ||
    Number(suppliedNode.version.slice(1).split(".")[0]) < 24
  )
    throw new Error(
      "The bundled Node must be version 24+ and match the build platform/architecture.",
    );
  for (const dir of [
    root,
    join(root, "apps/web"),
    join(root, "apps/market-mirror"),
    join(root, "apps/agent-runtime"),
  ])
    for (const name of await readdir(dir))
      if (/^\.env(?:\.|$)/.test(name) && name !== ".env.example")
        throw new Error(
          "Remove local .env files from the build checkout; deployment secrets must not enter the artifact.",
        );
  const source = await sourceManifest(),
    release =
      opts.release ||
      `artfi-${source.revision.slice(0, 12)}-${source.fingerprint.slice(0, 12)}-${process.platform}-${process.arch}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(release))
    throw new Error("Invalid release name.");
  const output = resolve(opts.output || join(root, "../packages")),
    bundle = join(output, release);
  await mkdir(output, { recursive: true });
  await mkdir(bundle, { recursive: false });
  const license = await readFile(nodeLicense);
  run(
    node,
    [join(root, "apps/web/node_modules/next/dist/bin/next"), "build"],
    join(root, "apps/web"),
  );
  run(
    node,
    [
      join(root, "apps/market-mirror/node_modules/typescript/bin/tsc"),
      "-p",
      "tsconfig.build.json",
    ],
    join(root, "apps/market-mirror"),
  );
  await mkdir(join(bundle, "runtime/bin"), { recursive: true });
  run(
    go,
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      join(bundle, "runtime/bin/artfi-api"),
      "./cmd/server",
    ],
    join(root, "apps/api"),
  );
  run(
    go,
    [
      "build",
      "-trimpath",
      "-ldflags=-s -w",
      "-o",
      join(bundle, "runtime/bin/artfi-migrate"),
      "../../scripts/install/migrate/main.go",
    ],
    join(root, "apps/api"),
  );
  run(forge, [
    "build",
    "src",
    "--root",
    join(root, "packages/contracts"),
    "--use",
    opts.solc || "0.8.30",
  ]);
  await bundleContracts(root, join(bundle, "contracts"), source.fingerprint);
  await cp(node, join(bundle, "runtime/bin/node"));
  await cp(
    join(root, "apps/web/.next/standalone"),
    join(bundle, "runtime/web"),
    { recursive: true, verbatimSymlinks: true },
  );
  await cp(
    join(root, "apps/web/.next/static"),
    join(bundle, "runtime/web/apps/web/.next/static"),
    { recursive: true },
  );
  await cp(
    join(root, "apps/web/public"),
    join(bundle, "runtime/web/apps/web/public"),
    { recursive: true },
  );
  // Next's tracing can omit SWC helper files that it loads by generated module path.
  for (const name of await readdir(join(root, "node_modules/.pnpm")))
    if (name.startsWith("@swc+helpers@") || name.startsWith("tslib@"))
      await cp(
        join(root, "node_modules/.pnpm", name),
        join(bundle, "runtime/web/node_modules/.pnpm", name),
        { recursive: true, verbatimSymlinks: true },
      );
  await rm(join(bundle, "runtime/web/apps/web/.next/cache"), {
    recursive: true,
    force: true,
  });
  await bundleNodePackage(
    join(root, "apps/market-mirror"),
    join(bundle, "runtime/mirror"),
    ["dist", "package.json", "README.md"],
  );
  await rm(join(bundle, "runtime/mirror/src"), {
    recursive: true,
    force: true,
  });
  await bundleNodePackage(
    join(root, "apps/agent-runtime"),
    join(bundle, "runtime/agent"),
    ["src", "package.json", "README.md", "config.example.json"],
  );
  await cp(join(root, "scripts/agent"), join(bundle, "scripts/agent"), {
    recursive: true,
  });
  await cp(join(root, "scripts/operations"), join(bundle, "tools/operations"), {
    recursive: true,
  });
  for (const directory of [
    join(bundle, "tools/operations"),
    join(bundle, "scripts/agent"),
  ]) {
    for (const name of await readdir(directory)) {
      if (
        /\.(?:test|integration)\.mjs$/.test(name) ||
        (/^(?:test-|.*-ci-test\.sh$)/.test(name) && name.endsWith(".sh"))
      )
        await rm(join(directory, name));
    }
  }
  // Exercise the packaged production dependency graph before sealing an artifact.
  // The guarded server module is imported only; no listener, configuration or signer starts.
  run(node, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(join(bundle, "runtime/agent/src/server.mjs")).href)});`,
  ]);
  await mkdir(join(bundle, "tools/acceptance"), { recursive: true });
  for (const name of [
    "installable-acceptance.mjs",
    "installable-browser-check.mjs",
  ]) {
    await cp(
      join(root, "scripts/test", name),
      join(bundle, "tools/acceptance", name),
    );
  }
  await cp(join(root, "apps/api/migrations"), join(bundle, "migrations"), {
    recursive: true,
  });
  await cp(join(root, "scripts/install"), join(bundle, "tools/install"), {
    recursive: true,
  });
  for (const name of [
    "INSTALLATION.md",
    "DELIVERY_CANDIDATE_2026-10-06.md",
    "ADMIN_MODERATION.md",
    "RWA_SOURCE_GROUNDING.md",
    "FRACTION_MATCHING.md",
    "PORTFOLIO_PERFORMANCE.md",
    "ADMIN_SAFE_WORKFLOW.md",
    "CLUSTER_OPERATIONS.md",
    "MYSQL_RECOVERY.md",
    "PERFORMANCE_CHECKS.md",
    "INSTALLABLE_ACCEPTANCE.md",
  ]) {
    const documentation = (await readFile(join(root, "docs", name), "utf8"))
      .replaceAll(
        "](../scripts/agent/STAGE2_SCOPE.md)",
        "](scripts/agent/STAGE2_SCOPE.md)",
      )
      .replaceAll(
        "](../apps/agent-runtime/README.md)",
        "](runtime/agent/README.md)",
      );
    await writeFile(join(bundle, name), documentation);
  }
  await mkdir(join(bundle, "licenses"));
  await writeFile(join(bundle, "licenses/NODE-LICENSE.txt"), license);
  await collectLicenses(root, bundle, go, env);
  await copyProjectNotices(root, bundle);
  await writeFile(
    join(bundle, "source-manifest.json"),
    JSON.stringify(source, null, 2) + "\n",
  );
  const after = await sourceManifest();
  if (
    after.fingerprint !== source.fingerprint ||
    after.revision !== source.revision
  )
    throw new Error(
      "Source changed during build; do not ship this artifact. Rebuild from a stable source snapshot.",
    );
  const { files, links } = await inventory(bundle);
  const manifest = {
    format: 1,
    release,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: suppliedNode.version,
    go: execFileSync(go, ["version"], { encoding: "utf8", env }).trim(),
    foundry: execFileSync(forge, ["--version"], { encoding: "utf8", env })
      .trim()
      .split("\n")[0],
    solidity: "0.8.30",
    source: {
      revision: source.revision,
      dirty: source.dirty,
      fingerprint: source.fingerprint,
    },
    migrations: Object.keys(files).filter((file) => file.endsWith(".up.sql"))
      .length,
    files,
    links,
  };
  await writeFile(
    join(bundle, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  run(node, [join(bundle, "tools/install/artfi.mjs"), "check-bundle"]);
  const archive = `${release}.tar.gz`;
  run("tar", ["-czf", join(output, archive), "-C", output, release]);
  const checksum = digest(await readFile(join(output, archive)));
  await writeFile(
    join(output, `${archive}.sha256`),
    `${checksum}  ${archive}\n`,
  );
  console.log(
    JSON.stringify({
      archive: join(output, archive),
      sha256: checksum,
      release,
      source: manifest.source,
    }),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
