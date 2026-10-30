import { isAbsolute } from "node:path";
import { observeBackup } from "../operations/mysql-recovery.mjs";

const fields = new Set([
  "id",
  "kind",
  "category",
  "maxAgeMs",
  "backupDirectory",
  "maxBackupAgeMs",
]);

export function validateBackupIntegrity(check) {
  if (
    !check ||
    typeof check !== "object" ||
    Array.isArray(check) ||
    check.kind !== "backup-integrity" ||
    check.category !== "backup" ||
    Object.keys(check).some((key) => !fields.has(key)) ||
    typeof check.backupDirectory !== "string" ||
    !isAbsolute(check.backupDirectory) ||
    /[\x00-\x1f\x7f]/.test(check.backupDirectory) ||
    !Number.isSafeInteger(check.maxBackupAgeMs) ||
    check.maxBackupAgeMs < 1000
  )
    throw new Error("BACKUP_INTEGRITY_CONFIG_REFUSED");
  return check;
}

function refuseAborted(signal) {
  if (signal?.aborted) throw new Error("BACKUP_OBSERVATION_ABORTED");
}

export function backupIntegrityProbe(checks, { now = Date.now } = {}) {
  const configured = new Map(
    checks.map((check) => {
      validateBackupIntegrity(check);
      const snapshot = Object.freeze({ ...check });
      return [snapshot.id, snapshot];
    }),
  );
  return async (id, signal) => {
    const check = configured.get(id);
    if (!check) throw new Error("UNKNOWN_PROBE");
    refuseAborted(signal);
    let observation;
    try {
      observation = await observeBackup(
        { backup: check.backupDirectory },
        { signal },
      );
    } catch {
      refuseAborted(signal);
      // Never retain backup paths, SQL, schema, hashes or diagnostic text.
    }
    refuseAborted(signal);
    const observedAt = now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new Error("BACKUP_OBSERVATION_CLOCK_REFUSED");
    const created =
      typeof observation?.createdAt === "string"
        ? Date.parse(observation.createdAt)
        : NaN;
    if (
      observation?.integrityVerified !== true ||
      !Number.isSafeInteger(created) ||
      created < 0 ||
      created > observedAt ||
      new Date(created).toISOString() !== observation.createdAt
    )
      return { available: false, fresh: false, observedAt };
    return {
      available: true,
      fresh: observedAt - created <= check.maxBackupAgeMs,
      observedAt,
    };
  };
}
