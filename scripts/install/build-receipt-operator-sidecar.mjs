import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleNodePackage } from "./bundle-node-package.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const within = (base, target) => {
  const part = relative(base, target);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep))
  );
};
const posix = (value) => value.split(sep).join("/");
const sensitive = (name) =>
  /^(?:\.git|\.aws|\.ssh|\.npmrc|\.netrc|\.pypirc|\.yarnrc(?:\.yml)?|\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$|\.(?:pem|key)$/i.test(
    name,
  );
const NOTICE = /^(?:licen[sc]e|notice|copying|copyright)(?:[._-].*)?$/i;

export const SIDECAR_PAYLOAD_FILES = Object.freeze([
  "scripts/release/verify-hoodi-charity-atomic-receipt.mjs",
  "scripts/release/lib/hoodi-charity-atomic-receipt.mjs",
  "scripts/release/prepare-isolated-hoodi-charity.mjs",
  "scripts/release/lib/isolated-hoodi-payload.mjs",
  "docs/HOODI-CHARITY-ATOMIC-RECEIPT.md",
  "docs/ISOLATED-HOODI-PAYLOAD.md",
  "docs/RECEIPT-OPERATOR-SIDECAR.md",
  "apps/web/package.json",
  "pnpm-lock.yaml",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "LICENSES/MIT.txt",
]);
export const SIDECAR_SOURCE_FILES = Object.freeze(
  [
    ...SIDECAR_PAYLOAD_FILES,
    "scripts/install/bundle-node-package.mjs",
    "scripts/install/build-receipt-operator-sidecar.mjs",
  ].sort(),
);

function exactKeys(value, keys, label) {
  if (
    !plain(value) ||
    Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")
  )
    throw Error(`Invalid ${label} fields`);
}
async function physicalDirectory(path) {
  const absolute = resolve(path);
  if (
    (await realpath(absolute)) !== absolute ||
    !(await lstat(absolute)).isDirectory()
  )
    throw Error("Directory must be physical");
  return absolute;
}
async function noSymlinkPath(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink())
      throw Error("Symlink input refused");
    if (dirname(current) === current) break;
  }
}
async function stableFile(path, maximum = 16 * 1024 * 1024) {
  await noSymlinkPath(path);
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > maximum)
      throw Error("Invalid input file");
    const bytes = await fd.readFile();
    const after = await fd.stat();
    const current = await lstat(path);
    if (
      bytes.length !== before.size ||
      [after, current].some(
        (s) =>
          s.dev !== before.dev ||
          s.ino !== before.ino ||
          s.size !== before.size ||
          s.mtimeMs !== before.mtimeMs ||
          s.ctimeMs !== before.ctimeMs ||
          !s.isFile(),
      )
    )
      throw Error("Input changed during read");
    return {
      bytes,
      size: bytes.length,
      sha256: digest(bytes),
      executable: (before.mode & 0o111) !== 0,
    };
  } finally {
    await fd.close();
  }
}
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function sourceGit(root) {
  if (resolve(git(root, ["rev-parse", "--show-toplevel"])) !== root)
    throw Error("Expected a repository root");
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]))
    throw Error("Selected source must be clean");
  return {
    revision: git(root, ["rev-parse", "HEAD"]),
    tree: git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}
async function sourceFiles(root) {
  const files = {};
  for (const path of SIDECAR_SOURCE_FILES) {
    const value = await stableFile(join(root, path));
    files[path] = { bytes: value.size, sha256: value.sha256 };
  }
  return files;
}
async function resolveDependency(directory, name, optional) {
  if (!PACKAGE.test(name)) throw Error("Invalid dependency name");
  for (let current = directory; ; current = dirname(current)) {
    try {
      return await realpath(join(current, "node_modules", name));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (dirname(current) === current) break;
  }
  if (optional) return null;
  throw Error(`Missing installed dependency: ${name}`);
}
async function packageFiles(directory) {
  const files = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      if (name === "node_modules") continue;
      if (sensitive(name)) throw Error("Sensitive dependency file refused");
      const file = join(path, name),
        rel = prefix + name,
        st = await lstat(file);
      if (st.isDirectory()) await walk(file, rel + "/");
      else if (st.isFile()) {
        const value = await stableFile(file);
        files[rel] = {
          bytes: value.size,
          sha256: value.sha256,
          executable: value.executable,
        };
      } else throw Error("Dependency special file or symlink refused");
    }
  }
  await walk(directory);
  return files;
}

/** Observe only the existing installed ethers graph; this is not dependency approval. */
export async function inspectReceiptDependencies(sourceRoot) {
  const root = await physicalDirectory(sourceRoot);
  const web = JSON.parse(
    (await stableFile(join(root, "apps/web/package.json"))).bytes.toString(
      "utf8",
    ),
  );
  const expected = web.dependencies?.ethers;
  if (typeof expected !== "string" || !VERSION.test(expected))
    throw Error("ethers requires an exact source version");
  const entry = createRequire(join(root, "apps/web/package.json")).resolve(
    "ethers",
  );
  let ethersRoot;
  for (
    let current = dirname(await realpath(entry));
    within(root, current);
    current = dirname(current)
  ) {
    try {
      const pkg = JSON.parse(
        (await stableFile(join(current, "package.json"))).bytes.toString(
          "utf8",
        ),
      );
      if (pkg.name === "ethers") {
        ethersRoot = current;
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current === root) break;
  }
  if (!ethersRoot) throw Error("Installed ethers root missing");
  const seen = new Map();
  async function visit(directory) {
    directory = await physicalDirectory(directory);
    if (!(
      within(join(root, "node_modules"), directory) ||
      within(join(root, "apps/web/node_modules"), directory)
    ))
      throw Error("Dependency outside selected source");
    const id = posix(relative(root, directory));
    if (seen.has(id)) return id;
    const data = JSON.parse(
      (await stableFile(join(directory, "package.json"))).bytes.toString(
        "utf8",
      ),
    );
    if (
      typeof data.name !== "string" ||
      !PACKAGE.test(data.name) ||
      !VERSION.test(data.version ?? "")
    )
      throw Error("Invalid installed package identity");
    for (const key of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      if (data[key] !== undefined && !plain(data[key]))
        throw Error("Invalid dependency declarations");
    const files = await packageFiles(directory);
    const notices = Object.keys(files).filter(
      (p) => !p.includes("/") && NOTICE.test(p),
    );
    if (!notices.length) throw Error(`Missing dependency notice: ${data.name}`);
    const record = {
      id,
      name: data.name,
      version: data.version,
      license:
        typeof data.license === "string"
          ? data.license
          : "SEE_PACKAGED_NOTICES",
      notices,
      files,
      dependencies: {},
      missingOptional: [],
    };
    seen.set(id, record);
    const requirements = {
      ...data.peerDependencies,
      ...data.dependencies,
      ...data.optionalDependencies,
    };
    for (const name of Object.keys(requirements).sort()) {
      const optional =
        Object.hasOwn(data.optionalDependencies ?? {}, name) ||
        data.peerDependenciesMeta?.[name]?.optional === true;
      const installed = await resolveDependency(directory, name, optional);
      if (installed) record.dependencies[name] = await visit(installed);
      else record.missingOptional.push(name);
    }
    return id;
  }
  const rootId = await visit(ethersRoot);
  const packages = [...seen.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const rootPackage = seen.get(rootId);
  if (rootPackage.name !== "ethers" || rootPackage.version !== expected)
    throw Error("Installed ethers version mismatch");
  const profile = { rootId, packages };
  return { ethersRoot, profile, fingerprint: digest(json(profile)) };
}

/** Full payload hashes, modes and physically confined relative symlinks. Does not import a tool. */
export async function inventoryReceiptSidecar(directory) {
  const root = await physicalDirectory(directory),
    files = {},
    links = {};
  async function walk(path, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      if (sensitive(name)) throw Error("Sensitive payload file refused");
      const file = join(path, name),
        rel = prefix + name,
        st = await lstat(file);
      if (st.isDirectory()) await walk(file, rel + "/");
      else if (st.isFile()) {
        const value = await stableFile(file);
        files[rel] = {
          bytes: value.size,
          sha256: value.sha256,
          executable: value.executable,
        };
      } else if (st.isSymbolicLink()) {
        const target = await readlink(file);
        if (
          isAbsolute(target) ||
          !within(root, resolve(dirname(file), target)) ||
          !within(root, await realpath(file))
        )
          throw Error("Dependency link escapes payload");
        links[rel] = target;
      } else throw Error("Special payload file refused");
    }
  }
  await walk(root);
  return { files, links };
}

export async function inspectReceiptSidecarSource(sourceRoot) {
  if (
    process.platform !== "linux" ||
    Number(process.versions.node.split(".")[0]) < 24
  )
    throw Error("Use the existing approved Linux Node 24+ runtime");
  const root = await physicalDirectory(sourceRoot),
    source = sourceGit(root);
  const files = await sourceFiles(root),
    dependencies = await inspectReceiptDependencies(root);
  if (
    json(sourceGit(root)) !== json(source) ||
    json(await sourceFiles(root)) !== json(files)
  )
    throw Error("Source drift during inspection");
  return {
    schema: "artfi-receipt-operator-selection/v1",
    ...source,
    files,
    dependencyFingerprint: dependencies.fingerprint,
  };
}
function validateSelection(selection) {
  exactKeys(
    selection,
    ["schema", "revision", "tree", "files", "dependencyFingerprint"],
    "selection",
  );
  if (
    selection.schema !== "artfi-receipt-operator-selection/v1" ||
    !SHA.test(selection.revision ?? "") ||
    !SHA.test(selection.tree ?? "") ||
    !HASH.test(selection.dependencyFingerprint ?? "")
  )
    throw Error("Invalid selection identity");
  exactKeys(selection.files, SIDECAR_SOURCE_FILES, "source inventory");
  for (const value of Object.values(selection.files)) {
    exactKeys(value, ["bytes", "sha256"], "source file");
    if (
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > 16 * 1024 * 1024 ||
      !HASH.test(value.sha256 ?? "")
    )
      throw Error("Invalid source file identity");
  }
}
const match = (selection, actual) => {
  if (
    selection.revision !== actual.revision ||
    selection.tree !== actual.tree ||
    selection.dependencyFingerprint !== actual.dependencyFingerprint
  )
    throw Error("Selected source or dependency identity changed");
  for (const path of SIDECAR_SOURCE_FILES)
    if (
      selection.files[path].bytes !== actual.files[path].bytes ||
      selection.files[path].sha256 !== actual.files[path].sha256
    )
      throw Error("Selected source file changed");
};

/** Build a separate, inactive source-layout tool payload from independently selected bytes. */
export async function buildReceiptOperatorSidecar({
  sourceRoot,
  output,
  selection,
}) {
  validateSelection(selection);
  const selected = JSON.parse(JSON.stringify(selection));
  const root = await physicalDirectory(sourceRoot);
  const before = await inspectReceiptSidecarSource(root);
  match(selected, before);
  const target = resolve(output);
  await physicalDirectory(dirname(target));
  if (within(root, target) || within(target, root))
    throw Error("Output must be outside the selected source");
  const dependencies = await inspectReceiptDependencies(root);
  if (dependencies.fingerprint !== selected.dependencyFingerprint)
    throw Error("Dependency drift before copy");
  await mkdir(target, { mode: 0o700 }); // EEXIST is final: never reuse, overwrite or remove an old result.
  try {
    const payload = join(target, "engineering-source");
    await mkdir(payload);
    for (const path of SIDECAR_PAYLOAD_FILES) {
      const file = await stableFile(join(root, path));
      const expected = selected.files[path];
      if (file.size !== expected.bytes || file.sha256 !== expected.sha256)
        throw Error("Source drift during copy");
      await mkdir(dirname(join(payload, path)), { recursive: true });
      await writeFile(join(payload, path), file.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    await bundleNodePackage(
      dependencies.ethersRoot,
      join(payload, "apps/web/node_modules/ethers"),
    );
    const inventory = await inventoryReceiptSidecar(payload);
    const after = await inspectReceiptSidecarSource(root);
    match(selected, after);
    const finalDependencies = await inspectReceiptDependencies(root);
    if (json(finalDependencies.profile) !== json(dependencies.profile))
      throw Error("Dependency files drifted during copy");
    // Reconstruct the existing copier's layout and verify all files and graph edges.
    // These hashes name packaging directories only, not business/receipt commitments.
    const packagePaths = new Map(
      dependencies.profile.packages.map((p) => {
        const source = join(root, p.id),
          marker = "/node_modules/.pnpm/";
        const storeId = digest(
          source.slice(source.lastIndexOf(marker) + marker.length),
        ).slice(0, 16);
        return [
          p.id,
          p.id === dependencies.profile.rootId
            ? "apps/web/node_modules/ethers"
            : `apps/web/node_modules/ethers/node_modules/.store/${storeId}`,
        ];
      }),
    );
    if (new Set(packagePaths.values()).size !== packagePaths.size)
      throw Error("Dependency layout collision");
    const expectedFiles = {},
      expectedLinks = {};
    for (const path of SIDECAR_PAYLOAD_FILES)
      expectedFiles[path] = { ...selected.files[path], executable: false };
    const copiedPackages = [];
    for (const pkg of dependencies.profile.packages) {
      const path = packagePaths.get(pkg.id);
      for (const [file, identity] of Object.entries(pkg.files))
        expectedFiles[`${path}/${file}`] = identity;
      for (const [name, targetId] of Object.entries(pkg.dependencies)) {
        const link = `${path}/node_modules/${name}`;
        expectedLinks[link] = posix(
          relative(
            dirname(join(payload, link)),
            join(payload, packagePaths.get(targetId)),
          ),
        );
      }
      if (
        !Object.hasOwn(pkg.dependencies, pkg.name) &&
        !pkg.missingOptional.includes(pkg.name)
      ) {
        const link = `${path}/node_modules/${pkg.name}`;
        expectedLinks[link] = posix(
          relative(dirname(join(payload, link)), join(payload, path)),
        );
      }
      copiedPackages.push({
        path,
        sourceId: pkg.id,
        name: pkg.name,
        version: pkg.version,
      });
    }
    const stable = (value) =>
      JSON.stringify(
        plain(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      );
    const sameMap = (a, b) =>
      Object.keys(a).sort().join("\0") === Object.keys(b).sort().join("\0") &&
      Object.keys(a).every((key) => stable(a[key]) === stable(b[key]));
    if (
      !sameMap(inventory.files, expectedFiles) ||
      !sameMap(inventory.links, expectedLinks)
    )
      throw Error("Copied payload bytes or graph differ");
    const manifest = {
      schema: "artfi-receipt-operator-sidecar/v1",
      status: "PACKAGED_NOT_ACCEPTED",
      source: selected,
      dependencies: dependencies.profile,
      copiedPackages,
      payload: inventory,
      payloadFingerprint: digest(json(inventory)),
      runtime: {
        bundled: false,
        required: "Existing independently approved Linux Node 24+",
        buildNode: process.version,
      },
      commands: [
        "engineering-source/scripts/release/prepare-isolated-hoodi-charity.mjs",
        "engineering-source/scripts/release/verify-hoodi-charity-atomic-receipt.mjs",
      ],
      toolsExecuted: false,
      networkUsed: false,
      authorization: "NOT_ESTABLISHED",
      wholeProductAccepted: false,
    };
    await writeFile(join(target, "manifest.json"), json(manifest), {
      flag: "wx",
      mode: 0o600,
    });
    return {
      status: manifest.status,
      manifestSha256: digest(json(manifest)),
      payloadFingerprint: manifest.payloadFingerprint,
      files: Object.keys(inventory.files).length,
      links: Object.keys(inventory.links).length,
    };
  } catch (error) {
    // A partial directory stays identifiable by the absence of a completed manifest.
    // Do not turn uncertain output into automatic cleanup or a replay.
    throw error;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--inspect-dependencies") {
      process.stdout.write(json(await inspectReceiptSidecarSource(root)));
    } else {
      if (
        args.length !== 4 ||
        args[0] !== "--selection" ||
        args[2] !== "--output"
      )
        throw Error("Invalid arguments");
      const selection = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          (await stableFile(resolve(args[1]), 512 * 1024)).bytes,
        ),
      );
      process.stdout.write(
        json(
          await buildReceiptOperatorSidecar({
            sourceRoot: root,
            output: args[3],
            selection,
          }),
        ),
      );
    }
  } catch {
    process.stderr.write(
      "Receipt operator packaging failed; preserve any partial output. No tool, service or transaction was started.\n",
    );
    process.exitCode = 1;
  }
}
