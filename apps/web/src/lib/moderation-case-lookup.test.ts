import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdministrationRequestError,
  type ModerationCase,
} from "./administration";
import {
  createPrivateCaseLookup,
  moderationCaseID,
  readPrivateModerationCase,
} from "./moderation-case-lookup";

const id = "a".repeat(32),
  wallet = "0x" + "1".repeat(40),
  session = { address: wallet, chainId: 560048 };
function record(patch: Partial<ModerationCase> = {}): ModerationCase {
  return {
    id,
    reporter: wallet,
    target: "TEST_ONLY content reference",
    category: "other",
    details: "TEST_ONLY private report details",
    status: "resolved",
    decision: "no_action",
    decisionReason: "TEST_ONLY reviewed explanation",
    publicNotice: "",
    revision: 3,
    appealStatus: "none",
    appealStatement: "",
    appealResponse: "",
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T01:00:00.123456789Z",
    ...patch,
  };
}
function handlers() {
  return { record: vi.fn(), busy: vi.fn(), error: vi.fn(), denied: vi.fn() };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("private moderation case direct lookup", () => {
  it("normalizes only a complete ID and refuses URL fragments or partial identifiers", () => {
    expect(moderationCaseID(" " + id.toUpperCase() + " ")).toBe(id);
    for (const raw of [
      "",
      id.slice(1),
      id + "?admin=true",
      "../" + id,
      "g".repeat(32),
    ])
      expect(() => moderationCaseID(raw)).toThrow();
  });
  it("copies only the complete display record with exact ID, reporter and safe revision", () => {
    const source = record(),
      result = readPrivateModerationCase(source, id, wallet);
    expect(result).toEqual(source);
    source.details = "changed after the read";
    expect(result.details).toBe("TEST_ONLY private report details");
    for (const patch of [
      { id: "b".repeat(32) },
      { reporter: "0x" + "2".repeat(40) },
      { revision: 0 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { revision: "3" },
      { status: "deleted" },
      { decision: "freeze_asset" },
      { appealStatus: "allowed" },
      { category: "unconfigured" },
      { details: "short" },
      { publicNotice: "x".repeat(501) },
      { createdAt: "2026-02-30T00:00:00Z" },
      { updatedAt: "not a time" },
      { privateKey: "TEST_ONLY forbidden" },
    ])
      expect(() =>
        readPrivateModerationCase({ ...record(), ...patch }, id, wallet),
      ).toThrow();
    const missing = { ...record() } as Partial<ModerationCase>;
    delete missing.appealResponse;
    expect(() => readPrivateModerationCase(missing, id, wallet)).toThrow();
  });
  it("does not invoke record getters", () => {
    let called = false;
    const value = record();
    Object.defineProperty(value, "details", {
      get() {
        called = true;
        return "TEST_ONLY getter";
      },
      enumerable: true,
    });
    expect(() => readPrivateModerationCase(value, id, wallet)).toThrow();
    expect(called).toBe(false);
  });
  it("uses the existing owner GET path and bound wallet/chain headers without a mutation body", async () => {
    const fetch = vi.fn(async () => Response.json(record()));
    vi.stubGlobal("fetch", fetch);
    const h = handlers(),
      reader = createPrivateCaseLookup(session, h);
    await reader.open(id);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/administration/user/moderation/cases/" + id);
    expect(options).toMatchObject({
      method: "GET",
      cache: "no-store",
      headers: { "x-artfi-wallet": wallet, "x-artfi-chain": "560048" },
    });
    expect(options.body).toBeUndefined();
    expect(h.record).toHaveBeenLastCalledWith(record());
    reader.retire();
  });
  it("never starts a request for an invalid ID", async () => {
    const h = handlers(),
      load = vi.fn(async () => record()),
      reader = createPrivateCaseLookup(session, h, load);
    await reader.open("../" + id);
    expect(load).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledWith(undefined);
    reader.retire();
  });
  it("rejects late success callbacks after clear, replacement or unmount", async () => {
    for (const mode of ["clear", "replace", "retire"]) {
      const h = handlers();
      let complete!: (value: unknown) => void;
      const load = vi.fn(
        () =>
          new Promise<unknown>((resolve) => {
            complete = resolve;
          }),
      );
      const reader = createPrivateCaseLookup(session, h, load);
      const first = reader.open(id);
      await Promise.resolve();
      await Promise.resolve();
      const finish = complete;
      let second: Promise<void> | undefined;
      if (mode === "clear") reader.clear();
      else if (mode === "replace") {
        second = reader.open("b".repeat(32));
        await Promise.resolve();
      } else reader.retire();
      const before = h.record.mock.calls.length;
      finish(record());
      await first;
      expect(h.record.mock.calls.length).toBe(before);
      reader.retire();
      if (second) await second;
    }
  });
  it("does not surface a retired request's late error into a replacement session", async () => {
    const h = handlers();
    let fail!: (reason: Error) => void;
    const load = vi.fn(
      () =>
        new Promise<unknown>((_, reject) => {
          fail = reject;
        }),
    );
    const reader = createPrivateCaseLookup(session, h, load);
    const pending = reader.open(id);
    await Promise.resolve();
    await Promise.resolve();
    reader.retire();
    await pending;
    const calls = h.error.mock.calls.length;
    fail(new AdministrationRequestError(401, "TEST_ONLY old session"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.error.mock.calls.length).toBe(calls);
    expect(h.denied).not.toHaveBeenCalled();
  });
  it("clears the old selection on 401/403 without treating absence as an empty owner list", async () => {
    for (const status of [401, 403, 404]) {
      const h = handlers(),
        load = vi.fn(async () => {
          throw new AdministrationRequestError(status, "TEST_ONLY");
        });
      const reader = createPrivateCaseLookup(session, h, load);
      await reader.open(id);
      expect(h.record).toHaveBeenCalledWith(undefined);
      expect(h.denied).toHaveBeenCalledTimes(status === 404 ? 0 : 1);
      if (status === 404)
        expect(h.error).toHaveBeenLastCalledWith(
          "The case was not found or is not available to this wallet.",
        );
      reader.retire();
    }
  });
  it("bounds even an abort-ignoring loader and never admits its late record", async () => {
    vi.useFakeTimers();
    const h = handlers();
    let complete!: (value: unknown) => void;
    const load = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          complete = resolve;
        }),
    );
    const reader = createPrivateCaseLookup(session, h, load);
    const pending = reader.open(id);
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(h.busy).toHaveBeenLastCalledWith(false);
    expect(h.error).toHaveBeenLastCalledWith(
      "The private case read was cancelled or timed out. Retry this read when available.",
    );
    const calls = h.record.mock.calls.length;
    complete(record());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.record.mock.calls.length).toBe(calls);
    reader.retire();
  });
});
