import { describe, expect, it, vi } from "vitest";
import { verifyHolderAccess, type HolderState } from "./charity-holder-state";

const address = "0x1000000000000000000000000000000000000001";
const verified = { address, tokenId: "7", expiresAt: "2026-10-02T22:00:00Z" };
const now = () => Date.parse("2026-10-02T21:00:00Z");
const descriptor = {
  contentType: "image/png",
  byteLength: 20,
  sha256: "a".repeat(64),
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let current = true;
  const states: HolderState[] = [];
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ message: "edition-specific challenge" }))
    .mockResolvedValueOnce(json(verified))
    .mockResolvedValueOnce(json(descriptor));
  const signMessage = vi.fn().mockResolvedValue("0xsigned");
  return {
    states,
    request,
    signMessage,
    leave: () => {
      current = false;
    },
    run: () =>
      verifyHolderAccess({
        address,
        tokenId: "7",
        request,
        signMessage,
        isCurrent: () => current,
        update: (state) => states.push(state),
        now,
      }),
  };
}

describe("holder proof stays bound to its mounted wallet and edition", () => {
  it("shows access only after signature, verified wallet/edition, and file descriptor", async () => {
    const flow = setup();
    await flow.run();
    expect(flow.signMessage).toHaveBeenCalledWith("edition-specific challenge");
    expect(flow.states.map((state) => state.step)).toEqual([
      "requesting-challenge",
      "awaiting-signature",
      "verifying",
      "verified",
    ]);
    expect(flow.states.at(-1)).toMatchObject({
      descriptor,
      expiresAt: verified.expiresAt,
    });
  });

  it("does not ask for a signature after the wallet/edition changes during the challenge", async () => {
    const flow = setup();
    const response = deferred<Response>();
    flow.request.mockReset().mockReturnValueOnce(response.promise);
    const running = flow.run();
    flow.leave();
    response.resolve(json({ message: "old challenge" }));
    await running;
    expect(flow.signMessage).not.toHaveBeenCalled();
    expect(flow.states.at(-1)?.step).toBe("requesting-challenge");
  });

  it("does not send a proof after context changes while the wallet is signing", async () => {
    const flow = setup();
    const signature = deferred<string>();
    flow.signMessage.mockReturnValue(signature.promise);
    const running = flow.run();
    await vi.waitFor(() => expect(flow.signMessage).toHaveBeenCalledOnce());
    flow.leave();
    signature.resolve("0xold");
    await running;
    expect(flow.request).toHaveBeenCalledTimes(1);
    expect(flow.states.at(-1)?.step).toBe("awaiting-signature");
  });

  it("does not fetch or show access after a stale verification response", async () => {
    const flow = setup();
    const response = deferred<Response>();
    flow.request
      .mockReset()
      .mockResolvedValueOnce(json({ message: "challenge" }))
      .mockReturnValueOnce(response.promise);
    const running = flow.run();
    await vi.waitFor(() => expect(flow.request).toHaveBeenCalledTimes(2));
    flow.leave();
    response.resolve(json(verified));
    await running;
    expect(flow.request).toHaveBeenCalledTimes(2);
    expect(flow.states.at(-1)?.step).toBe("verifying");
  });

  it("ignores a late file descriptor after leaving the screen", async () => {
    const flow = setup();
    const response = deferred<Response>();
    flow.request
      .mockReset()
      .mockResolvedValueOnce(json({ message: "challenge" }))
      .mockResolvedValueOnce(json(verified))
      .mockReturnValueOnce(response.promise);
    const running = flow.run();
    await vi.waitFor(() => expect(flow.request).toHaveBeenCalledTimes(3));
    flow.leave();
    response.resolve(json(descriptor));
    await running;
    expect(flow.states.at(-1)?.step).toBe("verifying");
  });

  it.each([
    { ...verified, address: "0x2000000000000000000000000000000000000002" },
    { ...verified, tokenId: "8" },
    { ...verified, expiresAt: "2026-10-02T20:00:00Z" },
    { ...verified, expiresAt: "invalid" },
  ])(
    "does not use a mismatched or expired grant response",
    async (response) => {
      const flow = setup();
      flow.request
        .mockReset()
        .mockResolvedValueOnce(json({ message: "challenge" }))
        .mockResolvedValueOnce(json(response));
      await flow.run();
      expect(flow.request).toHaveBeenCalledTimes(2);
      expect(flow.states.at(-1)?.step).toBe("error");
      expect(flow.states.at(-1)?.descriptor).toBeUndefined();
    },
  );

  it("makes descriptor failure retryable and clears any verified grant display", async () => {
    const flow = setup();
    flow.request
      .mockReset()
      .mockResolvedValueOnce(json({ message: "challenge" }))
      .mockResolvedValueOnce(json(verified))
      .mockResolvedValueOnce(json({ detail: "File unavailable" }, 503));
    await flow.run();
    expect(flow.states.at(-1)).toEqual({
      step: "error",
      message: "File unavailable",
    });
  });

  it("reports rejected signatures without a verification request", async () => {
    const flow = setup();
    flow.signMessage.mockRejectedValue(new Error("rejected"));
    await flow.run();
    expect(flow.request).toHaveBeenCalledTimes(1);
    expect(flow.states.at(-1)?.message).toContain("declined");
  });
});
