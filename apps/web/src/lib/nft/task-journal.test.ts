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
  return { config, requests, scopes, journal: createNftTaskJournal(config) };
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
