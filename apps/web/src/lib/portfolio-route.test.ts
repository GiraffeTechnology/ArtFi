import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/portfolio/[address]/route";
import { UserAuthError } from "./user-auth";

const session = vi.hoisted(() => vi.fn());
vi.mock("@/lib/user-auth", () => ({
  requireUserSession: session,
  UserAuthError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
const address = "0x1000000000000000000000000000000000000001";
const records = {
  address,
  chainId: 560048,
  network: "hoodi",
  positions: [],
  transactions: [],
  offers: [],
  notifications: [],
};
const request = (owner = address, query = "") =>
  GET(new Request(`https://app.example/api/portfolio/${owner}${query}`), {
    params: Promise.resolve({ address: owner }),
  });

describe("authenticated portfolio route", () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv("ARTFI_API_URL", "https://api.example");
    vi.stubGlobal("fetch", upstream);
    session.mockReset().mockResolvedValue({
      session: { address },
      accessToken: "unused-test-token",
    });
    upstream.mockReset().mockResolvedValue(Response.json(records));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it.each([401, 403, 503])(
    "fails closed before reading data for session status %i",
    async (status) => {
      session.mockRejectedValue(new UserAuthError(status, "private detail"));
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(upstream).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain("private detail");
    },
  );
  it("verifies the exact wallet and fetches bounded uncached records", async () => {
    const response = await request();
    expect(session).toHaveBeenCalledExactlyOnceWith(address);
    expect(upstream.mock.calls[0][0].toString()).toBe(
      `https://api.example/v1/portfolio/${address}`,
    );
    expect(upstream.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer unused-test-token" },
      cache: "no-store",
      redirect: "error",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(records);
  });
  it.each([
    { ...records, address: "0x2000000000000000000000000000000000000002" },
    { ...records, chainId: 1 },
    { ...records, positions: null },
  ])("rejects upstream records for an incorrect context", async (body) => {
    upstream.mockResolvedValue(Response.json(body));
    expect((await request()).status).toBe(503);
  });
  it("rejects malformed addresses and unexpected query parameters", async () => {
    expect((await request("invalid")).status).toBe(400);
    expect((await request(address, "?other=1")).status).toBe(400);
    expect(session).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("does not echo upstream failures or authentication values", async () => {
    upstream.mockResolvedValue(
      new Response("private upstream content", { status: 500 }),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(
      /private upstream|unused-test-token/,
    );
  });
});

describe("portfolio API complete projection and finite reads", () => {
  const upstream = vi.fn();
  beforeEach(() => {
    vi.stubEnv("ARTFI_API_URL", "https://api.example");
    vi.stubGlobal("fetch", upstream);
    session.mockReset().mockResolvedValue({
      session: { address },
      accessToken: "unused-test-token",
    });
    upstream.mockReset().mockResolvedValue(Response.json(records));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it.each([
    {
      ...records,
      positions: [
        {
          assetToken: address,
          symbol: "ART",
          balance: "1e3",
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
    },
    { ...records, transactions: [{ id: "foreign-record" }] },
    {
      ...records,
      notifications: [
        { id: "unsupported-notification", message: "private-origin-message" },
      ],
    },
  ])(
    "portfolio-projection regression rejects an incomplete known record",
    async (value) => {
      upstream.mockResolvedValue(Response.json(value));
      const response = await request();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private-origin-message");
    },
  );
  it("serializes the canonical known projection instead of extra upstream fields", async () => {
    upstream.mockResolvedValue(
      Response.json({
        ...records,
        internalCredential: "private-origin-secret",
        positions: [
          {
            assetToken: address,
            symbol: "ART",
            balance: "-1",
            updatedAt: "2026-10-01T10:00:00Z",
            privateNote: "not-public",
          },
        ],
      }),
    );
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ...records,
      positions: [
        {
          assetToken: address,
          symbol: "ART",
          balance: "-1",
          updatedAt: "2026-10-01T10:00:00Z",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private-origin-secret|not-public/,
    );
  });
  it("keeps the existing optional performance absence without inventing zero performance", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("performance");
    expect(session).toHaveBeenCalledExactlyOnceWith(address);
  });
  it("rejects contradictory known performance while preserving a valid existing unknown state", async () => {
    const performance = {
      status: "unknown",
      method: "fifo",
      scope: "confirmed_indexed_fraction_trades",
      items: [],
      unmappedTradeCount: 0,
      pendingEventCount: 1,
      reasons: ["history incomplete"],
    };
    upstream.mockResolvedValue(Response.json({ ...records, performance }));
    expect((await request()).status).toBe(200);
    upstream.mockResolvedValue(
      Response.json({
        ...records,
        performance: {
          ...performance,
          items: [
            {
              assetToken: address,
              paymentToken: null,
              confirmedQuantity: null,
              costBasis: null,
              realizedPnl: null,
              status: "known",
              buyCount: 0,
              sellCount: 0,
              reasons: [],
            },
          ],
        },
      }),
    );
    expect((await request()).status).toBe(503);
  });
  it.each(["session", "fetch", "body"])(
    "bounds a stalled %s read without retrying",
    async (phase) => {
      vi.useFakeTimers();
      if (phase === "session")
        session.mockImplementation(() => new Promise(() => undefined));
      if (phase === "fetch")
        upstream.mockImplementation(() => new Promise(() => undefined));
      if (phase === "body")
        upstream.mockResolvedValue(
          new Response(
            new ReadableStream({
              pull() {
                return new Promise(() => undefined);
              },
              cancel() {
                return new Promise(() => undefined);
              },
            }),
          ),
        );
      let response: Response | undefined;
      void request().then((value) => {
        response = value;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(response).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(response?.status).toBe(503);
      expect(upstream.mock.calls.length).toBe(phase === "session" ? 0 : 1);
    },
  );
  it("does not wait for cancellation of a refused response", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    upstream.mockResolvedValue(
      new Response(new ReadableStream({ cancel }), { status: 500 }),
    );
    let response: Response | undefined;
    void request().then((value) => {
      response = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(response?.status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledOnce();
  });
  it("rejects a cancelled request before authentication and forwarding", async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await GET(
      new Request(`https://app.example/api/portfolio/${address}`, {
        signal: controller.signal,
      }),
      { params: Promise.resolve({ address }) },
    );
    expect(response.status).toBe(503);
    expect(session).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("retires a pending body on request cancellation without returning late data", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    upstream.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => undefined);
          },
        }),
      ),
    );
    let response: Response | undefined;
    void GET(
      new Request(`https://app.example/api/portfolio/${address}`, {
        signal: controller.signal,
      }),
      { params: Promise.resolve({ address }) },
    ).then((value) => {
      response = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(response?.status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
