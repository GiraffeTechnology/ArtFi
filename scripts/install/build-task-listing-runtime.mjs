#!/usr/bin/env node
/** Close the real task runtime from the existing frozen pnpm installation. No resolver/install step. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleNodePackage } from "./bundle-node-package.mjs";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const builtin = (name) =>
  name.startsWith("node:") || builtinModules.includes(name);
const packageName = (name) =>
  name.startsWith("@")
    ? name.split("/").slice(0, 2).join("/")
    : name.split("/")[0];
const marker = "server-only";

function lockedPackageSources(bytes) {
  const text = bytes.toString("utf8");
  if (!text.startsWith("lockfileVersion: '9.0'\n"))
    throw Error("Unsupported pnpm lock format.");
  const section = text.split("\npackages:\n")[1]?.split("\nsnapshots:\n")[0];
  if (!section) throw Error("Frozen package resolution section is missing.");
  const sources = new Map();
  for (const match of section.matchAll(
    /^  ('[^']+'|[^\s:]+):\n    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}\n/gm,
  )) {
    const identity = match[1].replace(/^'|'$/g, "");
    if (sources.has(identity))
      throw Error("Duplicate frozen package identity.");
    sources.set(identity, match[2]);
  }
  return (name, version) => {
    const lockKey = `${name}@${version}`,
      integrity = sources.get(lockKey);
    if (!integrity)
      throw Error(
        `Required package is not pinned in the frozen lock: ${lockKey}`,
      );
    return {
      kind: "pnpm-lock-integrity",
      lockKey,
      integrity,
      registryTarball: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
      registryURLDerived: true,
    };
  };
}

async function inventory(directory, root = directory, files = {}, links = {}) {
  for (const name of (await readdir(directory)).sort()) {
    if (name.startsWith("."))
      throw Error(
        `Unexpected hidden runtime file: ${relative(root, join(directory, name))}`,
      );
    const path = join(directory, name),
      key = relative(root, path),
      stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      if (
        isAbsolute(target) ||
        relative(root, await realpath(path)).startsWith("..")
      )
        throw Error(`Runtime link escapes package: ${key}`);
      links[key] = target;
    } else if (stat.isDirectory()) await inventory(path, root, files, links);
    else if (stat.isFile()) files[key] = digest(await readFile(path));
    else throw Error(`Unsupported runtime file: ${key}`);
  }
  return { files, links };
}
/** Normalize the exporter's private store into ordinary npm package lookup paths.
 * npm pack does not preserve a linked private store's resolution graph. Copy each
 * resolved package/version and hoist only when the nearest Node lookup agrees. */
async function npmLayout(source, destination) {
  const placed = new Map(),
    copied = new Set(),
    normalization = [];
  async function place(directory, target) {
    directory = await realpath(directory);
    if (copied.has(target)) return;
    if (placed.has(target) && placed.get(target) !== directory)
      throw Error("Runtime dependency placement conflict.");
    placed.set(target, directory);
    copied.add(target);
    await cp(directory, target, {
      recursive: true,
      filter: (path) =>
        path === directory ||
        !relative(directory, path).split("/").includes("node_modules"),
    });
    const original = await readFile(join(directory, "package.json"));
    const pkg = JSON.parse(original);
    const removed = {};
    for (const key of ["preinstall", "install", "postinstall", "prepare"]) {
      if (Object.hasOwn(pkg.scripts || {}, key)) {
        removed[key] = pkg.scripts[key];
        delete pkg.scripts[key];
      }
    }
    if (Object.keys(removed).length)
      await writeFile(
        join(target, "package.json"),
        JSON.stringify(pkg, null, 2) + "\n",
      );
    const removedMetadataFiles = [];
    // This exact locked release contains one obsolete Node 0.8 CI configuration.
    // It has no runtime role; preserve the consumer's no-hidden-file boundary.
    if (pkg.name === "treeify" && pkg.version === "1.1.0") {
      const path = ".travis.yml",
        originalSha256 = digest(await readFile(join(target, path)));
      if (
        originalSha256 !==
        "54338079b530a045421714fd68523a2881e2d068e9ba43c4f06ec9fb10f0b652"
      )
        throw Error(
          "Unexpected treeify CI metadata; normalization must be reviewed.",
        );
      await rm(join(target, path));
      removedMetadataFiles.push({
        path,
        originalSha256,
        reason: "OBSOLETE_UPSTREAM_CI_METADATA",
      });
    }
    normalization.push({
      path: relative(destination, join(target, "package.json")),
      name: pkg.name,
      version: pkg.version,
      originalSha256: digest(original),
      normalizedSha256: digest(await readFile(join(target, "package.json"))),
      removedLifecycleScripts: Object.keys(removed).sort(),
      removedMetadataFiles,
    });
    const requirements = {
      ...pkg.peerDependencies,
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    };
    // Reserve direct names before recursive hoisting so transitive versions can
    // never displace the package's explicitly pinned direct dependencies.
    const children = [];
    // Optional peers are not runtime requirements. Leaving them absent matches
    // ordinary npm bundled-dependency packing and avoids native addon installers.
    const optionalOmissions = [];
    for (const name of Object.keys(requirements).sort()) {
      if (
        Object.hasOwn(pkg.optionalDependencies || {}, name) ||
        pkg.peerDependenciesMeta?.[name]?.optional
      ) {
        optionalOmissions.push(name);
        continue;
      }
      let dependency;
      try {
        dependency = await realpath(join(directory, "node_modules", name));
      } catch {
        if (
          Object.hasOwn(pkg.optionalDependencies || {}, name) ||
          pkg.peerDependenciesMeta?.[name]?.optional
        )
          continue;
        throw Error(`Closed runtime dependency is missing: ${name}`);
      }
      let nearest;
      for (
        let current = target;
        !relative(destination, current).startsWith("..");
        current = dirname(current)
      ) {
        const candidate = join(current, "node_modules", name);
        if (placed.has(candidate)) {
          nearest = candidate;
          break;
        }
        if (current === destination) break;
      }
      if (nearest && placed.get(nearest) === dependency) continue;
      const hoisted = join(destination, "node_modules", name);
      const child =
        nearest || placed.has(hoisted)
          ? join(target, "node_modules", name)
          : hoisted;
      placed.set(child, dependency);
      children.push([dependency, child]);
    }
    normalization[normalization.length - 1].omittedOptionalDependencies =
      optionalOmissions;
    for (const [dependency, child] of children) await place(dependency, child);
  }
  await place(source, destination);
  return normalization.sort((a, b) => a.path.localeCompare(b.path));
}

function run(node, args, cwd) {
  const environment = { ...process.env };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  for (const name of Object.keys(environment))
    if (/^(ARTFI_|OPENSEA_|NEXT_PUBLIC_)/.test(name)) delete environment[name];
  const child = spawnSync(node, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0)
    throw Error(
      `Task runtime verification command failed: ${child.stderr || child.error || child.stdout}`,
    );
  return child.stdout;
}

export async function buildTaskListingRuntime({
  root = DEFAULT_ROOT,
  destination,
  node = process.execPath,
} = {}) {
  root = await realpath(root);
  if (!destination) throw Error("Task runtime destination is required.");
  destination = resolve(destination);
  const web = join(root, "apps/web");
  const require = createRequire(join(web, "package.json"));
  const ts = require("typescript");
  const template = JSON.parse(
    await readFile(join(root, "scripts/task-runtime/package.json"), "utf8"),
  );
  const lock = await readFile(join(root, "pnpm-lock.yaml"));
  const lockedSource = lockedPackageSources(lock);
  const webPackage = JSON.parse(
    await readFile(join(web, "package.json"), "utf8"),
  );
  if (ts.version !== webPackage.devDependencies.typescript)
    throw Error("Installed TypeScript does not match the web lock.");
  const nextPackage = require("next/package.json");
  if (nextPackage.version !== webPackage.dependencies.next)
    throw Error("Installed Next does not match the web lock.");
  for (const [name, version] of Object.entries(template.dependencies)) {
    if (name !== marker && webPackage.dependencies[name] !== version)
      throw Error(`Task runtime dependency must match the web lock: ${name}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  // Never overwrite or remove an existing path supplied by an operator.
  await mkdir(destination, { recursive: false });
  const stage = await mkdtemp(join(tmpdir(), "artfi-task-runtime-stage-"));
  const closed = await mkdtemp(join(tmpdir(), "artfi-task-runtime-closed-"));
  const sourceFiles = {},
    external = new Set(),
    visited = new Set();
  async function visit(path) {
    path = await realpath(path);
    const sourcePath = relative(root, path);
    if (sourcePath.startsWith("..") || sourcePath.includes("node_modules"))
      throw Error("Runtime source escapes the application.");
    if (visited.has(path)) return;
    visited.add(path);
    const body = await readFile(path, "utf8");
    sourceFiles[sourcePath] = digest(body);
    let output = body;
    if (extname(path) === ".ts") {
      const result = ts.transpileModule(body, {
        fileName: path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          esModuleInterop: true,
          isolatedModules: true,
          sourceMap: false,
          declaration: false,
        },
      });
      if (
        result.diagnostics?.some(
          (item) => item.category === ts.DiagnosticCategory.Error,
        )
      )
        throw Error(`Task runtime compilation failed: ${sourcePath}`);
      output = result.outputText;
    } else if (extname(path) !== ".mjs")
      throw Error(`Unsupported runtime module: ${sourcePath}`);
    const syntax = ts.createSourceFile(
      path,
      output,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const imports = [];
    function scan(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) imports.push(node.moduleSpecifier);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        if (
          node.arguments.length !== 1 ||
          !ts.isStringLiteralLike(node.arguments[0])
        )
          throw Error(`Computed runtime imports are prohibited: ${sourcePath}`);
        imports.push(node.arguments[0]);
      }
      ts.forEachChild(node, scan);
    }
    scan(syntax);
    const replacements = [];
    for (const specifier of imports) {
      const name = specifier.text;
      if (builtin(name)) continue;
      if (!name.startsWith(".")) {
        if (!Object.hasOwn(template.dependencies, packageName(name)))
          throw Error(`Undeclared runtime dependency: ${name}`);
        external.add(packageName(name));
        continue;
      }
      const base = resolve(dirname(path), name);
      let target;
      for (const candidate of [base, `${base}.ts`, `${base}.mjs`]) {
        try {
          if ((await lstat(candidate)).isFile()) {
            target = candidate;
            break;
          }
        } catch {}
      }
      if (!target)
        throw Error(`Runtime module missing: ${sourcePath} -> ${name}`);
      await visit(target);
      if (name.endsWith(".ts"))
        replacements.push([
          specifier.getStart(syntax),
          specifier.getEnd(),
          JSON.stringify(name.replace(/\.ts$/, ".js")),
        ]);
    }
    for (const [start, end, replacement] of replacements.sort(
      (a, b) => b[0] - a[0],
    ))
      output = output.slice(0, start) + replacement + output.slice(end);
    const target = join(stage, "dist", sourcePath.replace(/\.ts$/, ".js"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output);
  }
  try {
    await visit(join(root, "scripts/task-runtime/server.mjs"));
    if (Object.keys(template.dependencies).some((name) => !external.has(name)))
      throw Error("Unused or missing runtime dependency declaration.");
    await mkdir(join(stage, "node_modules"), { recursive: true });
    const dependencies = {};
    for (const [name, version] of Object.entries(template.dependencies)) {
      const dependency =
        name === marker
          ? join(
              dirname(require.resolve("next/package.json")),
              "dist/compiled/server-only",
            )
          : await realpath(join(web, "node_modules", name));
      const pkg = JSON.parse(
        await readFile(join(dependency, "package.json"), "utf8"),
      );
      if (pkg.name !== name || pkg.version !== version)
        throw Error(`Installed runtime dependency version mismatch: ${name}`);
      const link = join(stage, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(dependency, link);
      dependencies[name] = {
        version,
        ...(name === marker
          ? {
              source: `next@${webPackage.dependencies.next}/dist/compiled/server-only`,
              conditionalExports: pkg.exports,
              sourceFiles: {
                "index.js": digest(
                  await readFile(join(dependency, "index.js")),
                ),
                "empty.js": digest(
                  await readFile(join(dependency, "empty.js")),
                ),
                "package.json": digest(
                  await readFile(join(dependency, "package.json")),
                ),
              },
            }
          : {}),
      };
    }
    template.bundledDependencies = Object.keys(template.dependencies);
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify(template, null, 2) + "\n",
    );
    await writeFile(
      join(stage, "server.mjs"),
      `import 'server-only';\nif (Number(process.versions.node.split('.')[0]) < 24) throw Error('ARTFI_LISTING_NODE_24_REQUIRED');\nimport { readFileSync } from 'node:fs';\nexport * from './dist/scripts/task-runtime/server.mjs';\nexport const runtimeManifest = Object.freeze(JSON.parse(readFileSync(new URL('./runtime-manifest.json', import.meta.url), 'utf8')));\n`,
    );
    for (const name of [
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "LICENSES",
    ])
      await cp(join(root, name), join(stage, name), { recursive: true });
    await cp(
      join(root, "docs/TASK_LISTING_RUNTIME.md"),
      join(stage, "README.md"),
    );
    await bundleNodePackage(stage, closed, [
      "dist",
      "package.json",
      "server.mjs",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "LICENSES",
      "README.md",
    ]);
    const normalization = await npmLayout(closed, destination);
    const packages = normalization
      .filter((entry) => entry.path !== "package.json")
      .map((entry) => ({
        path: dirname(entry.path),
        name: entry.name,
        version: entry.version,
        originalPackageSha256: entry.originalSha256,
        normalizedPackageSha256: entry.normalizedSha256,
        source:
          entry.name === marker
            ? {
                kind: "next-compiled",
                sourcePackage: `next@${nextPackage.version}`,
                parent: lockedSource("next", nextPackage.version),
                markerFiles: dependencies[marker].sourceFiles,
              }
            : lockedSource(entry.name, entry.version),
      }));
    const contents = await inventory(destination);
    for (const path of [
      "scripts/task-runtime/package.json",
      "scripts/install/build-task-listing-runtime.mjs",
      "scripts/install/bundle-node-package.mjs",
      "docs/TASK_LISTING_RUNTIME.md",
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
    ])
      sourceFiles[path] = digest(await readFile(join(root, path)));
    const sortedSources = Object.fromEntries(
      Object.entries(sourceFiles).sort(([a], [b]) => a.localeCompare(b)),
    );
    const manifest = {
      schema: "artfi-task-listing-runtime/1",
      packageName: template.name,
      packageVersion: template.version,
      walletInterface: "8415-task-listing-runtime/1",
      entry: "./server.mjs",
      node: { minimumMajor: 24, conditions: ["react-server"] },
      dependencies,
      normalization,
      packages,
      compiler: {
        name: "typescript",
        version: ts.version,
        target: "ES2022",
        module: "CommonJS",
      },
      source: {
        lockSha256: digest(lock),
        files: sortedSources,
        fingerprint: digest(JSON.stringify(sortedSources)),
      },
      ...contents,
    };
    await writeFile(
      join(destination, "runtime-manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    // New process, no source transpiler, no module mocks, no NODE_PATH/NODE_OPTIONS.
    run(
      node,
      [
        "--conditions=react-server",
        "--input-type=module",
        "-e",
        `const runtime = await import(${JSON.stringify(pathToFileURL(join(destination, "server.mjs")).href)}); if (typeof runtime.createNativeNftTaskPort !== 'function' || typeof runtime.createNftTaskJournal !== 'function' || typeof runtime.createListedOrderObserver !== 'function') throw Error('Missing runtime export');`,
      ],
      destination,
    );
    return {
      destination,
      manifestSha256: digest(
        await readFile(join(destination, "runtime-manifest.json")),
      ),
      manifest,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(closed, { recursive: true, force: true });
  }
}

/** Produce a file-dependency artifact and verify npm's exact packed layout. */
export async function packTaskListingRuntime({
  directory,
  archive,
  node = process.execPath,
} = {}) {
  directory = await realpath(directory);
  archive = resolve(archive);
  const temporary = await mkdtemp(join(tmpdir(), "artfi-task-runtime-pack-"));
  try {
    const packed = JSON.parse(
      run(
        "npm",
        [
          "pack",
          "--offline",
          "--ignore-scripts",
          "--json",
          "--cache",
          join(temporary, "cache"),
          "--pack-destination",
          temporary,
          directory,
        ],
        temporary,
      ),
    );
    if (
      packed.length !== 1 ||
      !/^[A-Za-z0-9._-]+\.tgz$/.test(packed[0].filename)
    )
      throw Error("Unexpected runtime archive.");
    const file = join(temporary, packed[0].filename);
    run("tar", ["-xzf", file, "-C", temporary], temporary);
    const extracted = join(temporary, "package");
    const manifest = JSON.parse(
      await readFile(join(extracted, "runtime-manifest.json"), "utf8"),
    );
    const contents = await inventory(extracted);
    delete contents.files["runtime-manifest.json"];
    if (
      JSON.stringify(contents.files) !== JSON.stringify(manifest.files) ||
      JSON.stringify(contents.links) !== JSON.stringify(manifest.links)
    )
      throw Error(
        "npm changed the verified runtime closure; refuse the archive.",
      );
    run(
      node,
      [
        "--conditions=react-server",
        "--input-type=module",
        "-e",
        "await import('./server.mjs');",
      ],
      extracted,
    );
    await mkdir(dirname(archive), { recursive: true });
    const bytes = await readFile(file);
    await writeFile(archive, bytes, { flag: "wx" });
    return {
      archive,
      sha256: digest(bytes),
      manifestSha256: digest(
        await readFile(join(extracted, "runtime-manifest.json")),
      ),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== "--output" ||
    (args.length === 4 && args[2] !== "--archive")
  ) {
    console.error(
      "Usage: node scripts/install/build-task-listing-runtime.mjs --output DIRECTORY [--archive FILE.tgz]",
    );
    process.exitCode = 1;
  } else
    try {
      const result = await buildTaskListingRuntime({ destination: args[1] });
      const packed =
        args.length === 4
          ? await packTaskListingRuntime({
              directory: result.destination,
              archive: args[3],
            })
          : {};
      console.log(
        JSON.stringify({
          destination: result.destination,
          manifestSha256: result.manifestSha256,
          ...packed,
        }),
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
}
