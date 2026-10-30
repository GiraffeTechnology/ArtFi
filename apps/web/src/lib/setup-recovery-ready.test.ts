import { describe, expect, it } from "vitest";
import { createSetupRecoverySession } from "./setup-recovery";

const validate = (value: unknown): value is { reviewed: true } =>
  !!value &&
  typeof value === "object" &&
  "reviewed" in value &&
  value.reviewed === true;

describe("setup restoration readiness", () => {
  it("publishes readiness synchronously for empty storage while SSR stays unready", () => {
    const session = createSetupRecoverySession("TEST_ONLY-empty", validate);
    const observed: boolean[] = [];
    session.subscribe(() => observed.push(session.getSnapshot().ready));
    expect(session.getSnapshot().ready).toBe(false);
    expect(session.begin()).toBeUndefined();
    session.restore(() => ({ getItem: () => null, setItem: () => {} }));
    expect(observed).toEqual([true]);
    expect(session.getSnapshot().ready).toBe(true);
    expect(session.getServerSnapshot().ready).toBe(false);
    expect(session.begin()).toBeDefined();
  });
  it.each(["throw", "corrupt"])(
    "marks %s storage read complete but keeps writes blocked",
    (mode) => {
      const session = createSetupRecoverySession("TEST_ONLY-failure", validate);
      session.restore(() => {
        if (mode === "throw") throw new Error("TEST_ONLY storage unavailable");
        return { getItem: () => "not-json", setItem: () => {} };
      });
      expect(session.getSnapshot()).toMatchObject({
        ready: true,
        blocked: true,
      });
      expect(session.begin()).toBeUndefined();
      expect(session.begin(true)).toBeDefined();
      expect(session.getServerSnapshot().ready).toBe(false);
    },
  );
  it("retains an uncertain pending record and does not reread or republish on repeated restore", () => {
    const session = createSetupRecoverySession("TEST_ONLY-pending", validate);
    const record = {
      version: 1,
      id: "record",
      data: { reviewed: true },
      pending: { id: "pending", step: "mint" },
    };
    let reads = 0,
      notices = 0;
    session.subscribe(() => {
      notices++;
    });
    session.restore(() => ({
      getItem: () => {
        reads++;
        return JSON.stringify(record);
      },
      setItem: () => {},
    }));
    const first = session.getSnapshot(),
      count = notices;
    session.restore(() => {
      throw new Error("must not reread");
    });
    expect(session.getSnapshot()).toBe(first);
    expect(reads).toBe(1);
    expect(notices).toBe(count);
    expect(first.ready).toBe(true);
    expect(first.record?.pending).toEqual(record.pending);
    expect(first.error).toContain("no known transaction hash");
    expect(session.begin()).toBeUndefined();
    expect(session.begin(true)).toBeDefined();
  });
});
