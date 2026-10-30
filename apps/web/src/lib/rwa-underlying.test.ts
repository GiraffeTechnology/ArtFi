import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/rwa/underlying-status/route";
import { currentOperation } from "./current-operation";
import {
  requireCurrentUnderlying,
  underlyingIdentityQuery,
} from "./rwa-underlying";
const identity = {
  chainId: 560048,
  collectionAddress: "0x1000000000000000000000000000000000000002",
  tokenId: "1",
};
const status = {
  ...identity,
  grounded: true,
  checkedAt: new Date().toISOString(),
};
const query = () =>
  new URLSearchParams({
    chainId: "560048",
    collectionAddress: identity.collectionAddress,
    tokenId: "1",
  });
describe("new fractional issuance source check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("rechecks the exact underlying without credentials immediately before the action", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(status));
    const active = currentOperation();
    await expect(
      requireCurrentUnderlying(identity, active.assertCurrent, request),
    ).resolves.toEqual(status);
    expect(request.mock.calls[0][0]).toContain("/api/rwa/underlying-status?");
    expect(request.mock.calls[0][1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });
  it.each([409, 503])(
    "blocks new issuance on revoked/expired or unavailable status %i",
    async (code) => {
      await expect(
        requireCurrentUnderlying(
          identity,
          () => {},
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("unavailable", { status: code })),
        ),
      ).rejects.toThrow();
    },
  );
  it("rejects changed identity, a negative response and retired action completion", async () => {
    for (const patch of [
      { tokenId: "2" },
      { grounded: false },
      { collectionAddress: "0x1000000000000000000000000000000000000003" },
    ])
      await expect(
        requireCurrentUnderlying(
          identity,
          () => {},
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json({ ...status, ...patch })),
        ),
      ).rejects.toThrow();
    const active = currentOperation();
    let resolve!: (value: Response) => void;
    const delayed = new Promise<Response>((done) => (resolve = done));
    const pending = requireCurrentUnderlying(
      identity,
      active.assertCurrent,
      () => delayed,
    );
    active.retire();
    resolve(Response.json(status));
    await expect(pending).rejects.toThrow();
  });
  it("bounds query keys and never forwards caller-supplied URLs or credentials", async () => {
    for (const suffix of [
      "&url=https://other.test",
      "&tokenId=2",
      "&callback=private",
    ]) {
      expect(() =>
        underlyingIdentityQuery(new URLSearchParams(query() + suffix)),
      ).toThrow();
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(
        (
          await GET(
            new Request(
              "https://web.test/api/rwa/underlying-status?" + query() + suffix,
            ),
          )
        ).status,
      ).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });
  it("uses the fixed backend path and validates the returned source-bound identity", async () => {
    vi.stubEnv("ARTFI_API_URL", "https://api.test/artfi");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(status));
    vi.stubGlobal("fetch", fetcher);
    const response = await GET(
      new Request("https://web.test/api/rwa/underlying-status?" + query()),
    );
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][0].toString()).toContain(
      "https://api.test/artfi/v1/rwa/underlying-status?",
    );
    expect(await response.json()).toEqual(status);
    fetcher.mockResolvedValue(Response.json({ ...status, tokenId: "9" }));
    expect(
      (
        await GET(
          new Request("https://web.test/api/rwa/underlying-status?" + query()),
        )
      ).status,
    ).toBe(503);
  });
});
