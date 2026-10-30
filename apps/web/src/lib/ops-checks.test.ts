import { describe, expect, it } from "vitest";

import {
  chainLagAfterSeconds,
  classifyApiRuntime,
  classifyChain,
  classifyContract,
  classifyMirror,
  classifyWebRuntime,
  mirrorStaleAfterSeconds,
  summarise,
  type CheckVerdict,
} from "./ops-checks";

const nowSeconds = 1_800_000_000;
const nowMs = nowSeconds * 1000;

describe("classifyWebRuntime", () => {
  it("is ok only when the runtime says so", () => {
    expect(classifyWebRuntime({ status: "ok", chainId: 560048 }).state).toBe(
      "ok",
    );
  });

  it("never reads silence or a malformed answer as healthy", () => {
    for (const payload of [
      undefined,
      null,
      "ok",
      200,
      { status: "degraded" },
    ]) {
      expect(classifyWebRuntime(payload).state).not.toBe("ok");
    }
  });
});

describe("classifyApiRuntime", () => {
  it("is ok on a reachable 200", () => {
    expect(classifyApiRuntime(true, 200).state).toBe("ok");
  });

  it("reports an unreachable API as unavailable, not healthy", () => {
    expect(classifyApiRuntime(false).state).toBe("unavailable");
    expect(classifyApiRuntime(false, 200).state).toBe("unavailable");
  });

  it("reports a reachable non-200 as degraded", () => {
    expect(classifyApiRuntime(true, 503).state).toBe("degraded");
    expect(classifyApiRuntime(true, 404).state).toBe("degraded");
  });
});

describe("classifyChain", () => {
  const head = {
    chainId: 560048,
    blockNumber: 12_345n,
    blockTimestampSeconds: nowSeconds - 20,
  };

  it("is ok on the configured chain with a recent head", () => {
    const verdict = classifyChain(head, 560048, nowSeconds);
    expect(verdict.state).toBe("ok");
    expect(verdict.detail).toContain("12345");
  });

  it("treats the wrong chain as unavailable, not degraded", () => {
    // Reading the wrong chain is worse than reading none: every figure downstream looks plausible.
    const verdict = classifyChain(head, 11155111, nowSeconds);
    expect(verdict.state).toBe("unavailable");
    expect(verdict.detail).toContain("560048");
  });

  it("reports a stale head as degraded", () => {
    const stale = {
      ...head,
      blockTimestampSeconds: nowSeconds - chainLagAfterSeconds - 1,
    };
    expect(classifyChain(stale, 560048, nowSeconds).state).toBe("degraded");
  });

  it("reports no answer as unavailable", () => {
    expect(classifyChain(undefined, 560048, nowSeconds).state).toBe(
      "unavailable",
    );
  });
});

describe("classifyMirror", () => {
  it("is ok on a recent observation", () => {
    const observed = new Date(nowMs - 30_000).toISOString();
    expect(classifyMirror(observed, nowMs).state).toBe("ok");
  });

  it("does not call an empty mirror healthy", () => {
    // No observation is not a quiet market. It is an absence, and it is reported as one.
    expect(classifyMirror(undefined, nowMs).state).toBe("not-checked");
  });

  it("reports a stale observation as degraded", () => {
    const stale = new Date(
      nowMs - (mirrorStaleAfterSeconds + 60) * 1000,
    ).toISOString();
    expect(classifyMirror(stale, nowMs).state).toBe("degraded");
  });

  it("reports a future observation rather than treating it as current", () => {
    const ahead = new Date(nowMs + 120_000).toISOString();
    expect(classifyMirror(ahead, nowMs).state).toBe("degraded");
  });

  it("reports an unreadable timestamp as unavailable", () => {
    expect(classifyMirror("not a timestamp", nowMs).state).toBe("unavailable");
  });
});

describe("classifyContract", () => {
  it("does not claim anything for an unconfigured address", () => {
    expect(classifyContract(false, undefined).state).toBe("not-checked");
    expect(classifyContract(false, true).state).toBe("not-checked");
  });

  it("separates an incomplete read from a failed one", () => {
    expect(classifyContract(true, undefined).state).toBe("not-checked");
    expect(classifyContract(true, false).state).toBe("unavailable");
    expect(classifyContract(true, true).state).toBe("ok");
  });
});

describe("summarise", () => {
  const verdict = (state: CheckVerdict["state"]): CheckVerdict => ({
    state,
    detail: "",
  });

  it("reports nothing checked as exactly that", () => {
    expect(summarise([]).state).toBe("not-checked");
  });

  it("lets one unavailable check dominate everything else", () => {
    expect(
      summarise([verdict("ok"), verdict("degraded"), verdict("unavailable")])
        .state,
    ).toBe("unavailable");
  });

  it("prefers degraded over an unchecked absence", () => {
    expect(
      summarise([verdict("ok"), verdict("degraded"), verdict("not-checked")])
        .state,
    ).toBe("degraded");
  });

  it("never upgrades an unchecked absence to ok", () => {
    const summary = summarise([verdict("ok"), verdict("not-checked")]);
    expect(summary.state).toBe("not-checked");
    expect(summary.detail).toContain("Nothing is claimed");
  });

  it("is ok only when every check answered", () => {
    expect(summarise([verdict("ok"), verdict("ok")]).state).toBe("ok");
  });
});
