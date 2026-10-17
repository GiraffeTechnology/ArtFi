import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}
function state(root) {
  const ids = git(root, ["rev-parse", "HEAD", "HEAD^{tree}"])
    .trim()
    .split("\n");
  if (ids.length !== 2 || ids.some((id) => !/^[a-f0-9]{40}$/.test(id)))
    throw new Error("Build source requires an exact Git commit and tree.");
  return {
    revision: ids[0],
    tree: ids[1],
    dirty: Boolean(git(root, ["status", "--porcelain"]).trim()),
  };
}
function names(root) {
  return [
    ...new Set(
      git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    ),
  ].sort();
}
const unchangedStat = (before, after) =>
  ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].every(
    (key) => before[key] === after[key],
  );
async function sourceFile(root, name) {
  if (
    isAbsolute(name) ||
    /[\\\x00-\x1f\x7f]/.test(name) ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsupported build source path.");
  const path = join(root, name);
  // Source links are not covered by the old files-only hash map. Refuse them
  // rather than follow an unrecorded dependency outside the approved snapshot.
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Build source links are unsupported.");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      (await realpath(`/proc/self/fd/${file.fd}`)) !== resolve(path)
    )
      throw new Error("Build source must be a stable regular file.");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    const after = await file.stat();
    if (
      bytes !== before.size ||
      !unchangedStat(before, after) ||
      !unchangedStat(after, await lstat(path)) ||
      (await realpath(path)) !== resolve(path)
    )
      throw new Error("Build source changed while it was read.");
    return {
      hash: hash.digest("hex"),
      mode: before.mode & 0o111 ? "100755" : "100644",
    };
  } finally {
    await file.close();
  }
}

/** Read-only capture for the existing Linux bundle builder. This detects
 * observable drift; it is not an atomic snapshot of a concurrently writable
 * checkout. Build from the existing isolated, single-writer input. */
export async function captureBuildSource(directory) {
  if (process.platform !== "linux")
    throw new Error("Capture native build source on Linux.");
  const root = await realpath(directory);
  const before = state(root);
  const paths = names(root);
  const files = Object.create(null),
    modes = Object.create(null);
  for (const name of paths) {
    const file = await sourceFile(root, name);
    files[name] = file.hash;
    modes[name] = file.mode;
  }
  const after = state(root);
  if (
    JSON.stringify(before) !== JSON.stringify(after) ||
    JSON.stringify(paths) !== JSON.stringify(names(root))
  )
    throw new Error("Git source changed during capture.");
  const format = 2;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ format, files, modes }))
    .digest("hex");
  return { format, ...before, fingerprint, files, modes };
}

export function assertBuildSourceUnchanged(before, after) {
  if (
    before.format !== 2 ||
    after.format !== 2 ||
    ["revision", "tree", "dirty", "fingerprint"].some(
      (key) => before[key] !== after[key],
    ) ||
    JSON.stringify(before.files) !== JSON.stringify(after.files) ||
    JSON.stringify(before.modes) !== JSON.stringify(after.modes)
  )
    throw new Error(
      "Source changed during build; do not ship this artifact. Rebuild from a stable source snapshot.",
    );
}
