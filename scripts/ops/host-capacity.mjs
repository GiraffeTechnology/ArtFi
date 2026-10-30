import { statfs } from "node:fs/promises";
import { freemem, totalmem, loadavg, availableParallelism } from "node:os";
import { isAbsolute } from "node:path";

const fields = new Set([
  "id",
  "category",
  "kind",
  "maxAgeMs",
  "diskPath",
  "minimumFreeDiskBytes",
  "minimumFreeDiskRatio",
  "minimumFreeMemoryRatio",
  "maximumLoadPerCPU",
]);

export function validateHostCapacity(check) {
  if (
    !check ||
    typeof check !== "object" ||
    Array.isArray(check) ||
    check.kind !== "host-capacity" ||
    check.category !== "capacity" ||
    Object.keys(check).some((key) => !fields.has(key)) ||
    typeof check.diskPath !== "string" ||
    !isAbsolute(check.diskPath) ||
    /[\x00-\x1f\x7f]/.test(check.diskPath)
  )
    throw new Error("HOST_CAPACITY_CONFIG_REFUSED");
  for (const key of ["minimumFreeDiskRatio", "minimumFreeMemoryRatio"]) {
    if (
      check[key] !== undefined &&
      (!Number.isFinite(check[key]) || check[key] <= 0 || check[key] >= 1)
    )
      throw new Error("HOST_CAPACITY_CONFIG_REFUSED");
  }
  if (
    check.minimumFreeDiskBytes !== undefined &&
    (!Number.isSafeInteger(check.minimumFreeDiskBytes) ||
      check.minimumFreeDiskBytes < 0)
  )
    throw new Error("HOST_CAPACITY_CONFIG_REFUSED");
  if (
    check.maximumLoadPerCPU !== undefined &&
    (!Number.isFinite(check.maximumLoadPerCPU) || check.maximumLoadPerCPU <= 0)
  )
    throw new Error("HOST_CAPACITY_CONFIG_REFUSED");
  return check;
}

function refuseAborted(signal) {
  if (signal?.aborted) throw new Error("HOST_CAPACITY_SAMPLE_ABORTED");
}

const defaultHost = () => ({
  freeMemoryBytes: freemem(),
  totalMemoryBytes: totalmem(),
  loadPerCPU: loadavg()[0] / availableParallelism(),
});

export function hostCapacityProbe(
  checks,
  { disk = statfs, host = defaultHost, now = Date.now } = {},
) {
  const configured = new Map(
    checks.map((check) => {
      validateHostCapacity(check);
      const snapshot = Object.freeze({ ...check });
      return [snapshot.id, snapshot];
    }),
  );
  return async (id, signal) => {
    const check = configured.get(id);
    if (!check) throw new Error("UNKNOWN_PROBE");
    refuseAborted(signal);
    let available = false;
    let fresh = false;
    try {
      const fs = await disk(check.diskPath, { bigint: true });
      refuseAborted(signal);
      const measurements = host();
      const maximum = BigInt(Number.MAX_SAFE_INTEGER);
      if (
        !fs ||
        ![fs.bavail, fs.blocks, fs.bsize].every(
          (v) => typeof v === "bigint" && v >= 0n && v <= maximum,
        ) ||
        fs.blocks === 0n ||
        fs.bsize === 0n ||
        fs.bavail > fs.blocks ||
        !measurements ||
        !Number.isSafeInteger(measurements.freeMemoryBytes) ||
        !Number.isSafeInteger(measurements.totalMemoryBytes) ||
        measurements.totalMemoryBytes <= 0 ||
        measurements.freeMemoryBytes < 0 ||
        measurements.freeMemoryBytes > measurements.totalMemoryBytes ||
        !Number.isFinite(measurements.loadPerCPU) ||
        measurements.loadPerCPU < 0
      )
        throw new Error("HOST_CAPACITY_MEASUREMENT_REFUSED");
      // Keep the byte floor exact even when multiplying safe block counters
      // produces a capacity above Number.MAX_SAFE_INTEGER.
      available =
        fs.bavail * fs.bsize >= BigInt(check.minimumFreeDiskBytes ?? 0) &&
        Number(fs.bavail) / Number(fs.blocks) >=
          (check.minimumFreeDiskRatio ?? 0.1) &&
        measurements.freeMemoryBytes / measurements.totalMemoryBytes >=
          (check.minimumFreeMemoryRatio ?? 0.05) &&
        measurements.loadPerCPU <= (check.maximumLoadPerCPU ?? 2);
      fresh = true;
    } catch {
      refuseAborted(signal);
      // A read error is not a healthy sample. Never retain its path or text.
    }
    refuseAborted(signal);
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error("HOST_CAPACITY_CLOCK_REFUSED");
    return { available, fresh, observedAt };
  };
}
