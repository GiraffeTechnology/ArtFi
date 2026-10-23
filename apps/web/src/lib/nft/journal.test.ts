import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { nftJournal, nftRequestHash, type NftOperation } from "./journal";
const wallet = "0x1111111111111111111111111111111111111111";
const id = "TEST_ONLY-operation-001";
function record(): NftOperation {
  const request = {
    action: "buy" as const,
    collection: "test-only",
    tokenId: "7",
    account: wallet as `0x${string}`,
    quantity: "1",
    priceWei: "100",
    expiresAt: 0,
    orderHash: `0x${"11".repeat(32)}` as `0x${string}`,
  };
  return {
    id,
    wallet,
    chainId: 1,
    requestHash: nftRequestHash(request),
    revision: 2,
    status: "pending",
    walletStarted: true,
    plan: {
      id: "TEST_ONLY-plan",
      operationId: id,
      sessionId: "TEST_ONLY-old-session",
      chainId: 1,
      request,
      scope: {
        slug: "test-only",
        chain: "ethereum",
        contract: "0x2222222222222222222222222222222222222222",
        standard: "erc1155",
        label: "TEST_ONLY",
        charity: false,
      },
      expiresAt: 1,
      kind: "transaction",
      summary: "TEST_ONLY unsigned original review",
      transaction: {
        to: "0x3333333333333333333333333333333333333333",
        data: "0x1234",
        value: "100",
      },
      fees: [],
    },
    transactionHash: `0x${"22".repeat(32)}`,
    updatedAt: "2026-10-19T13:00:00.123456789Z",
  };
}
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("ARTFI_API_URL", "https://journal-fixture.invalid");
  vi.stubEnv("ARTFI_USER_AUTH_BRIDGE_TOKEN", "TEST_ONLY_" + "x".repeat(32));
  fetcher = vi.fn(async () => Response.json(record()));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function reply(value: unknown) {
  fetcher.mockImplementation(async () => Response.json(value));
}
describe("native NFT session journal response admission", () => {
  it("reads the complete original unsigned operation including nanosecond time and expired review", async () => {
    const result = await nftJournal("get", { id }, "TEST_ONLY-access");
    expect(result).toEqual(record());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://journal-fixture.invalid/v1/nft/operations");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "get",
      accessToken: "TEST_ONLY-access",
      operation: { id },
    });
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("returns an idempotent create's old-session record without replacing its review or resetting recovery", async () => {
    const saved = record(),
      input = record();
    input.plan.sessionId = "TEST_ONLY-new-session";
    input.plan.id = "TEST_ONLY-new-plan";
    input.plan.expiresAt = Date.now() + 120000;
    input.revision = 1;
    input.walletStarted = false;
    input.status = "awaiting-wallet";
    const result = await nftJournal("create", input, "TEST_ONLY-access");
    expect(result).toEqual(saved);
    expect(result.plan.sessionId).toBe("TEST_ONLY-old-session");
  });
  it("accepts an exact update acknowledgement at the next durable revision", async () => {
    const input = record();
    reply({ ...input, revision: 3 });
    expect(
      (await nftJournal("update", input, "TEST_ONLY-access")).revision,
    ).toBe(3);
    expect(input.revision).toBe(2);
  });
  it.each(["wallet", "revision", "status"])(
    "journal-admission regression: rejects foreign or malformed %s",
    async (field) => {
      const value = record();
      Reflect.set(
        value,
        field,
        field === "wallet"
          ? "0x4444444444444444444444444444444444444444"
          : field === "revision"
            ? 0
            : "unknown-state",
      );
      reply(value);
      await expect(
        nftJournal("get", { id }, "TEST_ONLY-access"),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "chain",
    "request",
    "scope",
    "plan-id",
    "session",
    "task",
    "kind",
    "wallet-started",
    "revision-fraction",
    "request-digest",
    "hash-type",
    "order-hash",
    "time",
    "calendar",
    "extra",
    "signature",
    "token",
  ])(
    "rejects incompatible %s without exposing or replaying it",
    async (field) => {
      const value = record();
      if (field === "chain") value.chainId = 8453;
      if (field === "request")
        value.plan.request.account =
          "0x4444444444444444444444444444444444444444";
      if (field === "scope") value.plan.scope.chain = "base";
      if (field === "plan-id") value.plan.operationId = "TEST_ONLY-other-op";
      if (field === "session") Reflect.deleteProperty(value.plan, "sessionId");
      if (field === "task")
        Reflect.set(value.plan, "taskPrincipal", { kind: "task" });
      if (field === "kind") Reflect.set(value.plan, "kind", "other");
      if (field === "wallet-started")
        Reflect.deleteProperty(value, "walletStarted");
      if (field === "revision-fraction") value.revision = 1.5;
      if (field === "request-digest") value.requestHash = "0".repeat(64);
      if (field === "hash-type") Reflect.set(value, "transactionHash", 7);
      if (field === "order-hash") value.orderHash = "not-a-hash";
      if (field === "time") value.updatedAt = "not-a-time";
      if (field === "calendar") value.updatedAt = "2026-02-31T13:00:00Z";
      if (field === "extra") Reflect.set(value, "unexpected", true);
      if (field === "signature")
        Reflect.set(value.plan, "signedSignature", "TEST_ONLY-sensitive");
      if (field === "token")
        Reflect.set(value.plan, "accessToken", "TEST_ONLY-sensitive");
      reply(value);
      await expect(
        nftJournal("get", { id }, "TEST_ONLY-access"),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "revision",
    "plan",
    "status",
    "wallet-started",
    "transaction",
    "order",
    "wallet",
    "chain",
    "request",
  ])("rejects an update acknowledgement changing %s", async (field) => {
    const input = record(),
      value = { ...record(), revision: 3 };
    if (field === "revision") value.revision = 4;
    if (field === "plan") value.plan.summary = "Changed without review";
    if (field === "status") value.status = "confirmed";
    if (field === "wallet-started") value.walletStarted = false;
    if (field === "transaction") value.transactionHash = `0x${"44".repeat(32)}`;
    if (field === "order") value.orderHash = `0x${"44".repeat(32)}`;
    if (field === "wallet") {
      value.wallet = "0x4444444444444444444444444444444444444444";
      value.plan.request.account = value.wallet as `0x${string}`;
      value.requestHash = nftRequestHash(value.plan.request);
    }
    if (field === "chain") {
      value.chainId = 8453;
      value.plan.chainId = 8453;
      value.plan.scope.chain = "base";
    }
    if (field === "request") {
      value.plan.request.tokenId = "8";
      value.requestHash = nftRequestHash(value.plan.request);
    }
    reply(value);
    await expect(
      nftJournal("update", input, "TEST_ONLY-access"),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("snapshots input before awaiting the transport", async () => {
    const input = record(),
      expected = record();
    fetcher.mockImplementation(async () => {
      input.id = "TEST_ONLY-mutated-001";
      input.plan.request.tokenId = "99";
      return Response.json({ ...expected, revision: 3 });
    });
    expect((await nftJournal("update", input, "TEST_ONLY-access")).id).toBe(id);
    expect(
      JSON.parse(
        String(
          (fetcher.mock.calls[0] as unknown as [URL, RequestInit])[1].body,
        ),
      ).operation.plan.request.tokenId,
    ).toBe("7");
  });
  it.each([
    { label: "null", value: null },
    { label: "array", value: [] },
    { label: "object", value: {} },
    { label: "string", value: "invalid" },
  ])("rejects malformed result $label", async ({ value }) => {
    reply(value);
    await expect(
      nftJournal("get", { id }, "TEST_ONLY-access"),
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each(["json", "oversized", "network"])(
    "retains an uncertain %s acknowledgement without automatic write retry",
    async (kind) => {
      fetcher.mockImplementation(async () => {
        if (kind === "network")
          throw Error("TEST_ONLY interrupted acknowledgement");
        return new Response(kind === "json" ? "{" : "x".repeat(65537));
      });
      await expect(
        nftJournal("update", record(), "TEST_ONLY-access"),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([401, 403, 404, 409, 500])(
    "preserves upstream status %s and never retries",
    async (status) => {
      fetcher.mockImplementation(
        async () => new Response("TEST_ONLY private reason", { status }),
      );
      await expect(
        nftJournal("update", record(), "TEST_ONLY-access"),
      ).rejects.toMatchObject({ status: status === 500 ? 503 : status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("does not dispatch when the existing bridge is unavailable", async () => {
    vi.stubEnv("ARTFI_USER_AUTH_BRIDGE_TOKEN", "");
    await expect(
      nftJournal("get", { id }, "TEST_ONLY-access"),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});


function mysqlJsonOrdering(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mysqlJsonOrdering);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
        .map(([key, item]) => [key, mysqlJsonOrdering(item)]),
    );
  return value;
}
describe("native journal MySQL JSON round-trip", () => {
  it.each(["get", "create", "update"] as const)(
    "retains the original digest and terms after persisted key reordering for %s",
    async (action) => {
      const input = record();
      const wireHash = createHash("sha256")
        .update(JSON.stringify(input.plan.request))
        .digest("hex");
      const stored = record();
      if (action === "update") stored.revision += 1;
      reply(mysqlJsonOrdering(stored));
      const result = await nftJournal(
        action,
        action === "get" ? { id } : input,
        "TEST_ONLY-access",
      );
      expect(result.requestHash).toBe(wireHash);
      expect(result.plan.request).toEqual(input.plan.request);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("does not revalidate an expired original listing against the current clock", async () => {
    const stored = record();
    stored.plan.request.action = "list";
    stored.plan.request.expiresAt = 1;
    delete stored.plan.request.orderHash;
    stored.requestHash = createHash("sha256")
      .update(JSON.stringify(stored.plan.request))
      .digest("hex");
    reply(mysqlJsonOrdering(stored));
    expect((await nftJournal("get", { id }, "TEST_ONLY-access")).requestHash)
      .toBe(stored.requestHash);
  });
  it("does not discard unknown fields while reconstructing the original wire", async () => {
    const stored = record();
    Reflect.set(stored.plan.request, "unexpected", "unreviewed");
    reply(mysqlJsonOrdering(stored));
    await expect(nftJournal("get", { id }, "TEST_ONLY-access"))
      .rejects.toMatchObject({ status: 503 });
  });
});
