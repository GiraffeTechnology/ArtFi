import { afterEach, describe, expect, it, vi } from "vitest";
import {
  administrationKey,
  administrationRequest,
  administrationRoute,
} from "./administration";

describe("bounded application administration", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reuses an unchanged mutation key and separates path and revision", () => {
    const keys = new Map<string, string>();
    const create = vi
      .fn()
      .mockReturnValueOnce("one")
      .mockReturnValueOnce("two")
      .mockReturnValueOnce("three");
    expect(
      administrationKey(keys, "user/moderation/cases", { revision: 1 }, create),
    ).toBe("one");
    expect(
      administrationKey(keys, "user/moderation/cases", { revision: 1 }, create),
    ).toBe("one");
    expect(
      administrationKey(keys, "user/moderation/cases", { revision: 2 }, create),
    ).toBe("two");
    expect(
      administrationKey(keys, "admin/config", { revision: 2 }, create),
    ).toBe("three");
    expect(create).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["admin/session", "GET", true],
    ["user/moderation/cases", "POST", true],
    [`admin/moderation/cases/${"a".repeat(32)}/decisions`, "POST", true],
    [`user/moderation/cases/${"a".repeat(32)}/appeals`, "POST", true],
    ["admin/config", "PUT", true],
    ["moderation/notices", "GET", false],
    ["platform/config", "GET", false],
  ])("permits only specified %s %s route", (path, method, privateRoute) => {
    expect(administrationRoute(path.split("/"), method)).toEqual({
      upstream: `/v1/${path}`,
      private: privateRoute,
    });
  });
  it.each([
    ["admin/audit", "DELETE"],
    ["admin/config", "POST"],
    ["platform/config", "PUT"],
    ["admin/roles", "PUT"],
    ["admin/freeze", "POST"],
    ["user/moderation/cases/../audit", "GET"],
    ["user/moderation/cases", "DELETE"],
    ["admin/moderation/cases/invalid/decisions", "POST"],
  ])("rejects authority expansion %s %s", (path, method) => {
    expect(administrationRoute(path.split("/"), method)).toBeUndefined();
  });
  it("binds every private request to its displayed wallet and chain", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    vi.stubGlobal("fetch", fetch);
    await administrationRequest(
      "user/moderation/cases",
      { address: "0x1111", chainId: 560048 },
      {
        method: "POST",
        body: { details: "private" },
        key: "bounded-request-key",
      },
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/administration/user/moderation/cases",
      expect.objectContaining({
        cache: "no-store",
        headers: expect.objectContaining({
          "x-artfi-wallet": "0x1111",
          "x-artfi-chain": "560048",
          "idempotency-key": "bounded-request-key",
        }),
      }),
    );
  });
  it("surfaces a stale revision without silently resubmitting changed authority", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { detail: "Refresh the current revision." },
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(administrationRequest("admin/config")).rejects.toThrow(
      "Refresh the current revision.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
