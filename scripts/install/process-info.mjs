import { readFile, readlink } from "node:fs/promises";

/** Linux process identity survives application title changes while preventing PID-reuse kills. */
export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 2)
    throw new Error("Invalid process identifier.");
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  if (fields[0] === "Z") throw new Error("Process has exited.");
  return {
    started: fields[19],
    executable: await readlink(`/proc/${pid}/exe`),
  };
}
export async function isSameProcess(record) {
  try {
    const current = await readProcessIdentity(record.pid);
    return (
      current.started === record.started &&
      current.executable === record.executable
    );
  } catch {
    return false;
  }
}
