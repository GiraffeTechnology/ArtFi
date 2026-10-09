import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

/** Copy an already-installed production dependency graph without installing or resolving new versions. */
export async function bundleNodePackage(source, destination, rootFiles) {
  const rootSource = await realpath(source);
  const visited = new Map();
  async function dependency(directory, name, optional) {
    for (let current = directory; ; current = dirname(current)) {
      try {
        return await realpath(join(current, "node_modules", name));
      } catch {}
      if (dirname(current) === current) break;
    }
    if (optional) return null;
    throw new Error(`Installed dependency is missing: ${name}`);
  }
  async function copyPackage(directory, target) {
    directory = await realpath(directory);
    if (visited.has(directory)) return visited.get(directory);
    visited.set(directory, target);
    await cp(directory, target, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (path) => {
        if (path === directory) return true;
        const parts = relative(directory, path).split("/");
        return (
          !parts.includes("node_modules") &&
          (directory !== rootSource ||
            !rootFiles ||
            rootFiles.includes(parts[0]))
        );
      },
    });
    const data = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
    const requirements = {
      ...data.peerDependencies,
      ...data.dependencies,
      ...data.optionalDependencies,
    };
    for (const name of Object.keys(requirements || {}).sort()) {
      const optional =
        Object.hasOwn(data.optionalDependencies || {}, name) ||
        data.peerDependenciesMeta?.[name]?.optional === true;
      const resolved = await dependency(directory, name, optional);
      if (!resolved) continue;
      let installed = visited.get(resolved);
      if (!installed) {
        const identity = createHash("sha256")
          .update(
            resolved.slice(
              resolved.lastIndexOf("/node_modules/.pnpm/") +
                "/node_modules/.pnpm/".length,
            ),
          )
          .digest("hex")
          .slice(0, 16);
        installed = await copyPackage(
          resolved,
          join(destination, "node_modules/.store", identity),
        );
      }
      const link = join(target, "node_modules", name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), installed), link);
    }
    // Packages with an ESM subdirectory package.json can import their own public
    // name through node_modules instead of Node's package-scope self-reference.
    // Preserve that ordinary installed-package lookup in the flat private store.
    if (
      typeof data.name === "string" &&
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(data.name) &&
      !Object.hasOwn(requirements, data.name)
    ) {
      const link = join(target, "node_modules", data.name);
      await mkdir(dirname(link), { recursive: true });
      await symlink(relative(dirname(link), target), link);
    }
    return target;
  }
  await copyPackage(resolve(source), resolve(destination));
}
