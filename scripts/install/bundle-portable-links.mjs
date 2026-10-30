import { lstat, readlink, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const unchanged = (a, b) =>
  ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].every(
    (key) => a[key] === b[key],
  );
const contained = (root, target) => {
  const path = relative(root, target);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
};
const refuse = () =>
  new Error(
    "Artifact contains a non-portable, unstable or escaping filesystem entry.",
  );

/** Read-only guard for an isolated, single-writer build directory. Detects
 * observable link/entry drift; it is not an atomic snapshot or a content/secret
 * scan. Never prints link targets or resolved private host paths. */
export async function assertPortableBundleLinks(directory) {
  let root, rootBefore;
  try {
    const input = resolve(directory);
    rootBefore = await lstat(input);
    root = await realpath(input);
    if (
      root !== input ||
      !rootBefore.isDirectory() ||
      rootBefore.isSymbolicLink()
    )
      throw refuse();
  } catch {
    throw refuse();
  }
  let links = 0;
  async function visit(path) {
    const before = await lstat(path);
    if (before.isSymbolicLink()) {
      const target = await readlink(path);
      if (!target || isAbsolute(target) || /[\x00-\x1f\x7f\\]/.test(target))
        throw refuse();
      const lexical = resolve(path, "..", target);
      if (!contained(root, lexical)) throw refuse();
      let resolved;
      try {
        resolved = await realpath(path);
      } catch {
        throw refuse();
      }
      if (!contained(root, resolved)) throw refuse();
      const after = await lstat(path);
      if (!unchanged(before, after) || target !== (await readlink(path)))
        throw refuse();
      links += 1;
      return;
    }
    if (!before.isDirectory() && !before.isFile()) throw refuse();
    if (!contained(root, await realpath(path))) throw refuse();
    if (before.isDirectory()) {
      const entries = (await readdir(path)).sort();
      for (const entry of entries) await visit(join(path, entry));
      if (
        JSON.stringify(entries) !== JSON.stringify((await readdir(path)).sort())
      )
        throw refuse();
    }
    if (!unchanged(before, await lstat(path))) throw refuse();
  }
  try {
    await visit(root);
    if (
      !unchanged(rootBefore, await lstat(root)) ||
      (await realpath(root)) !== root
    )
      throw refuse();
  } catch {
    // Filesystem errors may embed absolute or escaped targets. The public build
    // failure deliberately retains neither those messages nor an error cause.
    throw refuse();
  }
  return { links, status: "PORTABLE_WITHIN_BUILD_ROOT" };
}
