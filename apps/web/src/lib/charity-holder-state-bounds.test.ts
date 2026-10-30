import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyHolderAccess, type HolderState } from "./charity-holder-state";
const holderRequestTimeoutMs = 8000;
const address = "0x1000000000000000000000000000000000000001";
const other = "0x2000000000000000000000000000000000000002";
const instant = Date.parse("2026-10-19T00:00:00Z");
const expiry = new Date(instant + 300_000).toISOString();
const challenge = {
  address,
  tokenId: "7",
  message: "TEST_ONLY charity edition 7 proof",
  expiresAt: expiry,
};
const verified = {
  verified: true,
  address,
  tokenId: "7",
  expiresAt: expiry,
  holderBenefit: "watermarked-copy-after-ownership-verification",
};
const descriptor = {
  tokenId: "7",
  class: "watermarked-holder",
  contentType: "image/png",
  byteLength: 20,
  sha256: "a".repeat(64),
  objectKey: "TEST_ONLY/watermarked",
  artworkPreview: "not-provided",
  rights:
    "This edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.",
};
function setup(values: unknown[] = [challenge, verified, descriptor]) {
  const states: HolderState[] = [];
  let time = instant;
  let index = 0;
  const request = vi.fn<typeof fetch>(async () =>
    Response.json(values[index++]),
  );
  const signMessage = vi.fn(async () => "0x" + "12".repeat(65));
  const controller = new AbortController();
  const run = () =>
    verifyHolderAccess({
      address,
      tokenId: "7",
      request,
      signMessage,
      signal: controller.signal,
      isCurrent: () => true,
      update: (s) => states.push(s),
      now: () => time,
    });
  return {
    states,
    request,
    signMessage,
    controller,
    run,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("strict holder contract regressions", () => {
  it("refuses a challenge for another wallet before signing", async () => {
    const f = setup([{ ...challenge, address: other }, verified, descriptor]);
    await f.run();
    expect(f.signMessage).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)?.step).toBe("error");
  });
  it("refuses an expired challenge before signing", async () => {
    const f = setup([
      { ...challenge, expiresAt: new Date(instant).toISOString() },
      verified,
      descriptor,
    ]);
    await f.run();
    expect(f.signMessage).not.toHaveBeenCalled();
    expect(f.states.at(-1)?.step).toBe("error");
  });
  it("does not turn verified false into ownership", async () => {
    const f = setup([challenge, { ...verified, verified: false }, descriptor]);
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.states.at(-1)?.step).toBe("error");
  });
  it("does not show access for an invalid holder digest", async () => {
    const f = setup([challenge, verified, { ...descriptor, sha256: "bad" }]);
    await f.run();
    expect(f.states.at(-1)?.step).toBe("error");
    expect(f.states.at(-1)?.descriptor).toBeUndefined();
  });
});
describe("holder bounded network and complete response contract", () => {
  it.each([
    { ...challenge, tokenId: "8" },
    { ...challenge, message: undefined },
    { ...challenge, message: "" },
    { ...challenge, message: "x".repeat(4097) },
    { ...challenge, extra: "not part of the route" },
    { ...challenge, expiresAt: "invalid" },
  ])(
    "refuses malformed challenge %# before any wallet prompt",
    async (value) => {
      const f = setup([value, verified, descriptor]);
      await f.run();
      expect(f.signMessage).not.toHaveBeenCalled();
      expect(f.states.at(-1)?.step).toBe("error");
    },
  );
  it.each([
    { ...verified, holderBenefit: "master" },
    { ...verified, verified: "true" },
    { ...verified, extra: true },
  ])(
    "refuses incomplete verification contract %# before descriptor",
    async (value) => {
      const f = setup([challenge, value, descriptor]);
      await f.run();
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.states.at(-1)?.step).toBe("error");
    },
  );
  it.each([
    { ...descriptor, tokenId: "8" },
    { ...descriptor, class: "master" },
    { ...descriptor, artworkPreview: "https://example.invalid/preview" },
    { ...descriptor, byteLength: 0 },
    { ...descriptor, byteLength: 1.5 },
    { ...descriptor, contentType: "text/html" },
    { ...descriptor, previewUrl: "https://example.invalid/master" },
    { ...descriptor, masterSha256: "b".repeat(64) },
  ])(
    "refuses malformed/private descriptor %# without enabling download",
    async (value) => {
      const f = setup([challenge, verified, value]);
      await f.run();
      expect(f.states.at(-1)?.step).toBe("error");
      expect(f.states.at(-1)?.descriptor).toBeUndefined();
    },
  );
  it("retains only public file facts in verified React state", async () => {
    const f = setup();
    await f.run();
    expect(f.states.at(-1)).toEqual({
      step: "verified",
      expiresAt: expiry,
      descriptor: {
        contentType: "image/png",
        byteLength: 20,
        sha256: "a".repeat(64),
      },
    });
    for (const [, options] of f.request.mock.calls)
      expect(options).toMatchObject({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
  });
  it("does not send an expired proof after the human finishes signing", async () => {
    const f = setup();
    f.signMessage.mockImplementation(async () => {
      f.advance(300_001);
      return "0x12";
    });
    await f.run();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.states.at(-1)?.step).toBe("error");
  });
  it.each([0, 1, 2])(
    "bounds stalled response headers at step %i without retry",
    async (stall) => {
      vi.useFakeTimers();
      const f = setup();
      let resolve!: (r: Response) => void;
      let index = 0;
      f.request.mockImplementation(() =>
        index++ === stall
          ? new Promise((done) => {
              resolve = done;
            })
          : Promise.resolve(
              Response.json([challenge, verified, descriptor][index - 1]),
            ),
      );
      const running = f.run();
      await vi.advanceTimersByTimeAsync(holderRequestTimeoutMs + 1);
      expect(f.request).toHaveBeenCalledTimes(stall + 1);
      expect(f.states.at(-1)?.step).toBe("error");
      expect(f.states.at(-1)?.message).toContain("timed out");
      resolve(Response.json([challenge, verified, descriptor][stall]));
      await running;
      expect(f.request).toHaveBeenCalledTimes(stall + 1);
    },
  );
  it("bounds a stalled body even if cancellation never settles", async () => {
    vi.useFakeTimers();
    const f = setup();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    f.request.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"address":'));
          },
          cancel,
        }),
      ),
    );
    const running = f.run();
    await vi.advanceTimersByTimeAsync(holderRequestTimeoutMs + 1);
    await running;
    expect(f.states.at(-1)?.step).toBe("error");
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.signMessage).not.toHaveBeenCalled();
  });
  it("rejects oversized and malformed UTF8 bodies before signing", async () => {
    for (const bytes of [
      new Uint8Array(16_385).fill(32),
      new Uint8Array([0xff, 0xfe]),
    ]) {
      const f = setup();
      f.request.mockResolvedValueOnce(new Response(bytes));
      await f.run();
      expect(f.signMessage).not.toHaveBeenCalled();
      expect(f.states.at(-1)?.step).toBe("error");
    }
  });
  it("does not expose a raw network diagnostic or oversized upstream error", async () => {
    const f = setup();
    f.request.mockRejectedValueOnce(
      new Error("PRIVATE_TEST_ONLY_NETWORK_DETAIL"),
    );
    await f.run();
    expect(f.states.at(-1)?.message).not.toContain("PRIVATE_TEST_ONLY");
    const g = setup();
    g.request.mockResolvedValueOnce(
      Response.json(
        { detail: "PRIVATE_TEST_ONLY_" + "x".repeat(2048) },
        { status: 503 },
      ),
    );
    await g.run();
    expect(g.states.at(-1)?.message).not.toContain("PRIVATE_TEST_ONLY");
  });
  it("aborts an in-flight header wait without a late prompt or replay", async () => {
    const f = setup();
    let resolve!: (r: Response) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const running = f.run();
    f.controller.abort();
    await running;
    resolve(Response.json(challenge));
    await Promise.resolve();
    expect(f.signMessage).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});
