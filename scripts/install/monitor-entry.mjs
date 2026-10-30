import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export function monitorArguments(root, file, descriptor) {
  if (
    typeof file !== "string" ||
    !isAbsolute(file) ||
    /[\x00-\x1f\x7f]/.test(file) ||
    !descriptor ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor)
  )
    throw new Error("MONITOR_DESCRIPTOR_REFUSED");
  // Existing format-1 deployments retain their original implementation and CLI.
  // A new schema is selected only by its explicit, unambiguous discriminator.
  if (descriptor.format === 1 && descriptor.schemaVersion === undefined)
    return [join(root, "tools/operations/monitor.mjs"), file, "--watch"];
  if (
    descriptor.schemaVersion === 1 &&
    descriptor.format === undefined &&
    descriptor.mode === "monitor-only"
  )
    return [join(root, "tools/ops/monitor-service.mjs"), file];
  throw new Error("MONITOR_DESCRIPTOR_REFUSED");
}

export async function readMonitorArguments(root, file) {
  let handle;
  try {
    handle = await open(file, "r");
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 262144)
      throw new Error("MONITOR_DESCRIPTOR_REFUSED");
    const buffer = Buffer.alloc(262145);
    let bytes = 0;
    while (bytes < buffer.length) {
      const part = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (part.bytesRead === 0) break;
      bytes += part.bytesRead;
    }
    if (bytes > 262144) throw new Error("MONITOR_DESCRIPTOR_REFUSED");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, bytes),
    );
    return monitorArguments(root, file, JSON.parse(text));
  } catch {
    throw new Error("MONITOR_DESCRIPTOR_REFUSED");
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        throw new Error("MONITOR_DESCRIPTOR_REFUSED");
      }
    }
  }
}
