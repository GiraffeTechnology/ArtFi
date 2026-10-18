import { lstat, realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import {
  join,
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  sep,
} from "node:path";
import { createHash } from "node:crypto";

export const monitorFiles = Object.freeze([
  "monitor-core.mjs",
  "monitor-service.mjs",
  "host-capacity.mjs",
  "monitor-status.mjs",
  "README.md",
  "artfi-monitor@.service",
]);

export async function bundleMonitor(root, destination) {
  const source = join(await realpath(root), "scripts/ops");
  const directory = await lstat(source);
  const output = join(
    await realpath(dirname(resolve(destination))),
    basename(destination),
  );
  const outputRelative = relative(source, output);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (await realpath(source)) !== source ||
    outputRelative === "" ||
    (!isAbsolute(outputRelative) &&
      outputRelative !== ".." &&
      !outputRelative.startsWith(".." + sep))
  )
    throw new Error("MONITOR_PACKAGE_SOURCE_REFUSED");
  // Resolve the entire fixed public payload before creating an output directory.
  // Private descriptors, state, fixtures and untracked additions are never copied.
  const inputs = [];
  for (const name of monitorFiles) {
    const path = join(source, name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
      throw new Error("MONITOR_PACKAGE_SOURCE_REFUSED");
    const bytes = await readFile(path);
    if (bytes.length > 1048576)
      throw new Error("MONITOR_PACKAGE_SOURCE_REFUSED");
    inputs.push({ name, bytes });
  }
  await mkdir(output, { mode: 0o755 });
  const records = [];
  for (const { name, bytes } of inputs) {
    await writeFile(join(output, name), bytes, { flag: "wx", mode: 0o644 });
    const copied = await readFile(join(output, name));
    if (!copied.equals(bytes))
      throw new Error("MONITOR_PACKAGE_READBACK_REFUSED");
    records.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(copied).digest("hex"),
    });
  }
  return records;
}
