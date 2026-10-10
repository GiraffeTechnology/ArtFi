import { execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

export const PROJECT_NOTICE_FILES = Object.freeze([
  ["LICENSE", "LICENSE"],
  ["NOTICE", "NOTICE"],
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
  ["LICENSES/MIT.txt", "LICENSES/MIT.txt"],
  ["apps/web/src/fonts/INTER-LICENSE.txt", "licenses/fonts/INTER-LICENSE.txt"],
]);

/** Copy only the named product and separately licensed notices before sealing. */
export async function copyProjectNotices(root, bundle) {
  for (const [source, destination] of PROJECT_NOTICE_FILES) {
    const input = join(root, source);
    if (!(await lstat(input)).isFile())
      throw new Error(`Project notice must be a regular file: ${source}`);
    const output = join(bundle, destination);
    await mkdir(dirname(output), { recursive: true });
    await cp(input, output);
  }
}

/** Keep build-dependency notices as well as runtime notices; never copy machine paths into the inventory. */
export async function collectLicenses(root, bundle, go, env) {
  const inventory = [],
    seen = new Set();
  async function notices(directory, name, version, ecosystem) {
    const key = `${ecosystem}:${name}@${version}`;
    if (seen.has(key)) return;
    seen.add(key);
    const names = (await readdir(directory)).filter((name) =>
      /^(?:licen[sc]e|notice|copying|copyright)(?:[._-].*)?$/i.test(name),
    );
    const destination = join(
      bundle,
      "licenses/dependencies",
      `${ecosystem}-${name.replaceAll("/", "_").replaceAll("@", "")}@${version}`,
    );
    const files = [];
    for (const name of names)
      if ((await lstat(join(directory, name))).isFile()) {
        await mkdir(destination, { recursive: true });
        await cp(join(directory, name), join(destination, name));
        files.push(name);
      }
    inventory.push({ ecosystem, name, version, notices: files });
  }
  const store = join(root, "node_modules/.pnpm");
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const modules = join(store, entry.name, "node_modules");
    let packages;
    try {
      packages = await readdir(modules, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of packages) {
      if (!pkg.isDirectory()) continue;
      const dirs = pkg.name.startsWith("@")
        ? (await readdir(join(modules, pkg.name), { withFileTypes: true }))
            .filter((p) => p.isDirectory())
            .map((p) => join(modules, pkg.name, p.name))
        : [join(modules, pkg.name)];
      for (const directory of dirs) {
        try {
          const data = JSON.parse(
            await readFile(join(directory, "package.json"), "utf8"),
          );
          if (data.name && data.version)
            await notices(directory, data.name, data.version, "npm");
        } catch {}
      }
    }
  }
  const modules = execFileSync(
    go,
    ["list", "-m", "-f", "{{.Path}}|{{.Version}}|{{.Dir}}", "all"],
    { cwd: join(root, "apps/api"), env, encoding: "utf8" },
  );
  for (const line of modules.trim().split("\n")) {
    const [name, version, directory] = line.split("|");
    if (version && directory) await notices(directory, name, version, "go");
  }
  const goroot = execFileSync(go, ["env", "GOROOT"], {
    env,
    encoding: "utf8",
  }).trim();
  await cp(join(goroot, "LICENSE"), join(bundle, "licenses/GO-LICENSE.txt"));
  inventory.sort((a, b) =>
    `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(
      `${b.ecosystem}:${b.name}@${b.version}`,
    ),
  );
  await writeFile(
    join(bundle, "dependency-inventory.json"),
    JSON.stringify(
      {
        scope:
          "Build and runtime dependency inventory; not every build dependency is present in the runtime.",
        packages: inventory,
      },
      null,
      2,
    ) + "\n",
  );
}
