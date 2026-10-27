import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  createNftTaskJournal,
  nftTaskJournalDigest,
  type NftTaskJournalConfig,
} from "./task-journal";
import type { NftOperation } from "./journal";
import type { NftTaskPrincipal } from "./model";

const principal: NftTaskPrincipal = {
  kind: "task",
  taskId: "task-test-only",
  taskDigest: `0x${"1".repeat(64)}`,
  executorDigest: `0x${"2".repeat(64)}`,
  grantReference: "grant:test-only",
  grantPolicyVersion: "1",
  operationId: "wallet-operation-test-only",
};
function record(): NftOperation {
  return {
    id: "native_test_operation_123",
    wallet: `0x${"1".repeat(40)}`,
    chainId: 1,
    requestHash: "a".repeat(64),
    revision: 1,
    status: "awaiting-wallet",
    walletStarted: false,
    updatedAt: "2026-10-10T07:00:00.000Z",
    plan: {
      id: "native_plan_123",
      operationId: "native_test_operation_123",
      taskPrincipal: structuredClone(principal),
      chainId: 1,
      request: {
        action: "list",
        collection: "test-only",
        tokenId: "1",
        account: `0x${"1".repeat(40)}`,
        quantity: "1",
        priceWei: "100",
        expiresAt: 1900000000,
      },
      scope: {
        slug: "test-only",
        chain: "ethereum",
        contract: `0x${"2".repeat(40)}`,
        standard: "erc721",
        label: "Test only",
        charity: false,
      },
      expiresAt: 1900000000000,
      kind: "signature",
      summary: "Synthetic unsigned test plan",
      fees: [],
    },
  };
}
function fixture(result = record()) {
  let gateHeld = false;
  const requests: { url: string; init: RequestInit }[] = [];
  const scopes: unknown[] = [];
  const config: NftTaskJournalConfig = {
    url: "https://journal.invalid/internal/v1/nft/operations",
    peerId: "spiffe://test-only/wallet",
    async transport(url, init) {
      expect(gateHeld).toBe(true);
      requests.push({ url, init });
      return Response.json(result);
    },
    async withCapability(scope, dispatch) {
      scopes.push(scope);
      gateHeld = true;
      try {
        return await dispatch("synthetic-capability-not-a-real-credential");
      } finally {
        gateHeld = false;
      }
    },
  };
  return {
    config,
    requests,
    scopes,
    isGateHeld: () => gateHeld,
    journal: createNftTaskJournal(config),
  };
}
describe("fixed authenticated task journal adapter", () => {
  it("fails closed without configuration or on an insecure endpoint", async () => {
    await expect(
      createNftTaskJournal()(principal, "get", { id: record().id }),
    ).rejects.toMatchObject({ status: 503 });
    const { config } = fixture();
    config.url = "http://journal.invalid/internal/v1/nft/operations";
    await expect(
      createNftTaskJournal(config)(principal, "get", { id: record().id }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("binds action, operation, plan, peer and entire body; keeps gate held across transport", async () => {
    const f = fixture();
    const result = await f.journal(principal, "create", record());
    expect(result.id).toBe(record().id);
    expect(f.requests).toHaveLength(1);
    const request = f.requests[0];
    const body = JSON.parse(String(request.init.body));
    expect(body).toEqual({ action: "create", operation: record() });
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("principal");
    expect(f.scopes[0]).toMatchObject({
      peerId: f.config.peerId,
      action: "create",
      nativeOperationId: record().id,
      planDigest: nftTaskJournalDigest(body.operation.plan),
      requestDigest: nftTaskJournalDigest(body),
    });
    expect(request.init).toMatchObject({
      cache: "no-store",
      redirect: "error",
    });
  });
  it("get binds an exact operation without creating plan authority", async () => {
    const f = fixture();
    await f.journal(principal, "get", { id: record().id });
    expect(f.scopes[0]).toMatchObject({ action: "get", planDigest: "" });
  });
  it("rejects body-owned task rebinding and any session fabrication before dispatch", async () => {
    for (const mutation of [
      (x: NftOperation) => {
        x.plan.taskPrincipal!.taskId = "foreign";
      },
      (x: NftOperation) => {
        x.plan.sessionId = "fabricated-session";
      },
    ]) {
      const f = fixture();
      const operation = record();
      mutation(operation);
      await expect(
        f.journal(principal, "create", operation),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.requests).toHaveLength(0);
    }
  });
  it.each([
    "signature",
    "exactSignature",
    "signatures",
    "typedDataSignature",
    "private_key",
    "rawTransaction",
    "privateKey",
    "capability",
    "seedPhrase",
  ])("never transmits %s", async (key) => {
    const f = fixture();
    const operation = record();
    Object.assign(operation.plan, { nested: [{ [key]: "TEST_ONLY" }] });
    await expect(
      f.journal(principal, "create", operation),
    ).rejects.toMatchObject({ status: 422 });
    expect(f.requests).toHaveLength(0);
  });
  it("rejects foreign or changed response plans", async () => {
    for (const mutation of [
      (x: NftOperation) => {
        x.plan.taskPrincipal!.taskId = "foreign";
      },
      (x: NftOperation) => {
        x.plan.request.priceWei = "101";
      },
      (x: NftOperation) => {
        x.revision = 0;
      },
      (x: NftOperation) => {
        x.plan.sessionId = "session";
      },
    ]) {
      const operation = record();
      const changed = structuredClone(operation);
      mutation(changed);
      await expect(
        fixture(changed).journal(principal, "create", operation),
      ).rejects.toMatchObject({ status: 503 });
    }
  });
  it("requires exact CAS revision in update response", async () => {
    const original = record();
    await expect(
      fixture(original).journal(principal, "update", original),
    ).rejects.toMatchObject({ status: 503 });
    const next = structuredClone(original);
    next.revision = 2;
    await expect(
      fixture(next).journal(principal, "update", original),
    ).resolves.toMatchObject({ revision: 2 });
  });
  it("never retries a transport failure or HTTP conflict", async () => {
    for (const response of [null, new Response("conflict", { status: 409 })]) {
      const f = fixture();
      const transport = vi.fn(async () => {
        if (response) return response;
        throw Error("unknown response");
      });
      f.config.transport = transport;
      await expect(
        createNftTaskJournal(f.config)(principal, "update", record()),
      ).rejects.toMatchObject({ status: response ? 409 : 503 });
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  describe.each([403, 409, 429])("HTTP %s response cleanup", (status) => {
    it.each(["pending", "rejected", "locked", "empty"] as const)(
      "releases the capability gate with a %s body without retrying",
      async (mode) => {
        const f = fixture();
        const cleanup = vi.fn(() => {
          if (mode === "pending") return new Promise<void>(() => {});
          if (mode === "rejected")
            return Promise.reject(new Error("Synthetic cleanup failure"));
        });
        const body =
          mode === "empty"
            ? null
            : new ReadableStream<Uint8Array>({ cancel: cleanup });
        const reader = mode === "locked" ? body!.getReader() : undefined;
        const response = new Response(body, { status });
        const transport = vi.fn(async () => {
          expect(f.isGateHeld()).toBe(true);
          return response;
        });
        f.config.transport = transport;
        const gate = vi.spyOn(f.config, "withCapability");
        const journal = createNftTaskJournal(f.config);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            journal(principal, "update", record()).then(
              () => ({ kind: "unexpected-success" as const }),
              (error: unknown) => ({ kind: "error" as const, error }),
            ),
            new Promise<{ kind: "cleanup-timeout" }>((resolve) => {
              timer = setTimeout(
                () => resolve({ kind: "cleanup-timeout" }),
                1000,
              );
            }),
          ]);
          expect(result.kind).toBe("error");
          if (result.kind !== "error")
            throw new Error("The HTTP failure did not release the gate.");
          expect(result.error).toMatchObject({
            status: status === 429 ? 503 : status,
            message:
              "The task operation could not be verified. Read its durable state before retrying.",
          });
          expect(f.isGateHeld()).toBe(false);
          expect(transport).toHaveBeenCalledTimes(1);
          expect(gate).toHaveBeenCalledTimes(1);
          expect(f.scopes).toHaveLength(1);
          expect(cleanup).toHaveBeenCalledTimes(
            mode === "locked" || mode === "empty" ? 0 : 1,
          );
          // Let a rejected cancellation settle so Vitest can detect unhandled errors.
          await new Promise<void>((resolve) => setImmediate(resolve));
        } finally {
          clearTimeout(timer);
          reader?.releaseLock();
        }
      },
    );
  });
  it("pins dependencies and snapshots operation before capability awaits", async () => {
    const f = fixture();
    const operation = record();
    f.config.transport = async () => {
      throw Error("mutated after composition");
    };
    await expect(
      f.journal(principal, "get", { id: operation.id }),
    ).resolves.toMatchObject({ id: operation.id });
  });
  it("prevents a capability callback from issuing two HTTP operations", async () => {
    const f = fixture();
    f.config.withCapability = async (_scope, dispatch) => {
      await dispatch("synthetic-capability-not-a-real-credential");
      return dispatch("synthetic-capability-not-a-real-credential");
    };
    f.config.transport = async () => Response.json(record());
    await expect(
      createNftTaskJournal(f.config)(principal, "get", { id: record().id }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("uses identical Go canonical digest for escaped Unicode and numeric object keys", () => {
    const expected =
      '{"10":"\\u003c\\u003e\\u0026\\u2028\\u2029\u96ea","2":[true,null,2]}';
    expect(
      nftTaskJournalDigest({
        "2": [true, null, 2],
        "10": "<>&\u2028\u2029\u96ea",
      }),
    ).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(() =>
      nftTaskJournalDigest({ x: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
    expect(() => nftTaskJournalDigest({ "\u96ea": 1 })).toThrow();
  });
});

describe("native task journal exact update acknowledgements", () => {
  it.each(["status", "wallet-started", "transaction"])(
    "task-ack regression: rejects changed %s at an otherwise correct revision",
    async (field) => {
      const original = record(),
        next = { ...record(), revision: 2 };
      if (field === "status") next.status = "confirmed";
      if (field === "wallet-started") next.walletStarted = true;
      if (field === "transaction")
        next.transactionHash = "0x" + "22".repeat(32);
      const f = fixture(next);
      await expect(
        f.journal(principal, "update", original),
      ).rejects.toMatchObject({ status: 503 });
      expect(f.requests).toHaveLength(1);
      expect(f.scopes).toHaveLength(1);
    },
  );
  it("rejects an injected order reference without replaying the update", async () => {
    const f = fixture({
      ...record(),
      revision: 2,
      orderHash: "0x" + "33".repeat(32),
    });
    await expect(
      f.journal(principal, "update", record()),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.requests).toHaveLength(1);
  });
  it.each(["transaction", "order"])(
    "rejects a missing or replaced %s reference",
    async (field) => {
      const original = record();
      if (field === "transaction")
        original.transactionHash = "0x" + "44".repeat(32);
      else original.orderHash = "0x" + "55".repeat(32);
      for (const missing of [true, false]) {
        const next = { ...structuredClone(original), revision: 2 };
        if (field === "transaction") {
          if (missing) Reflect.deleteProperty(next, "transactionHash");
          else next.transactionHash = "0x" + "66".repeat(32);
        } else {
          if (missing) Reflect.deleteProperty(next, "orderHash");
          else next.orderHash = "0x" + "66".repeat(32);
        }
        const f = fixture(next);
        await expect(
          f.journal(principal, "update", original),
        ).rejects.toMatchObject({ status: 503 });
        expect(f.requests).toHaveLength(1);
      }
    },
  );
  it("accepts the complete exact next durable result including original public hash spelling", async () => {
    const original = {
        ...record(),
        status: "pending",
        walletStarted: true,
        transactionHash: "0x" + "AB".repeat(32),
        orderHash: "0x" + "CD".repeat(32),
      },
      next = { ...structuredClone(original), revision: 2 };
    const f = fixture(next);
    expect(await f.journal(principal, "update", original)).toEqual(next);
    expect(original.revision).toBe(1);
    expect(f.requests).toHaveLength(1);
  });
  it("preserves a progressed idempotent create rather than treating it as a new update acknowledgement", async () => {
    const next = {
      ...record(),
      revision: 9,
      status: "pending",
      walletStarted: true,
      transactionHash: "0x" + "77".repeat(32),
    };
    const f = fixture(next);
    expect(await f.journal(principal, "create", record())).toEqual(next);
  });
  it("does not infer update equality for a read-only recovered record", async () => {
    const next = {
      ...record(),
      revision: 9,
      status: "pending",
      walletStarted: true,
      transactionHash: "0x" + "77".repeat(32),
    };
    const f = fixture(next);
    expect(await f.journal(principal, "get", { id: record().id })).toEqual(
      next,
    );
  });
  it("checks the outer held-context return as well as the transport response", async () => {
    const next = { ...record(), revision: 2 },
      f = fixture(next);
    f.config.withCapability = async (_scope, dispatch) => {
      const value = await dispatch(
        "synthetic-capability-not-a-real-credential",
      );
      Reflect.set(value as object, "status", "confirmed");
      return value;
    };
    f.config.transport = async () => Response.json(next);
    const journal = createNftTaskJournal(f.config);
    await expect(journal(principal, "update", record())).rejects.toMatchObject({
      status: 503,
    });
  });
  it("uses the original submitted snapshot after a caller mutates during the held context await", async () => {
    const original = record(),
      next = { ...record(), revision: 2 },
      f = fixture(next);
    f.config.withCapability = async (_scope, dispatch) => {
      original.status = "confirmed";
      original.walletStarted = true;
      return dispatch("synthetic-capability-not-a-real-credential");
    };
    f.config.transport = async () => Response.json(next);
    expect(
      (await createNftTaskJournal(f.config)(principal, "update", original))
        .status,
    ).toBe("awaiting-wallet");
  });
});
