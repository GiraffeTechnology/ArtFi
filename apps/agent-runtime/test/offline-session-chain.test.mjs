import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineReadService } from "../src/composition.mjs";

const wallet = `0x${"a".repeat(40)}`;
const row = {
  id: "op",
  state: "STARTED",
  request: {
    intent: { wallet },
    execution: { chainId: "560048", executor: wallet },
    sale: { nft: wallet, tokenId: "1" },
  },
};
const session = (chainId) => ({
  authenticated: true,
  wallet,
  chainId,
  expiresAt: 2000,
});

function offlineService({ get = async () => structuredClone(row), listEvents = async () => [] } = {}) {
  return createOfflineReadService({ get, listEvents }, () => 1000);
}

test(
  "offline reads bind a durable intent to the authenticated wallet and chain",
  async () => {
    let historyReads = 0;
    const service = offlineService({
      listEvents: async () => {
        historyReads++;
        return [{ id: "1" }];
      },
    });

    for (const chainId of ["1", "8453"])
      await assert.rejects(
        service.getHistory(session(chainId), "op", {}),
        /OPERATION_NOT_FOUND/,
      );
    assert.equal(historyReads, 0);

    const intent = await service.getIntent(session("560048"), "op");
    assert.equal(intent.domain.chainId, "560048");
    assert.equal(intent.fresh, false);
    assert.deepEqual(
      (await service.getHistory(session("560048"), "op", {})).events,
      [{ id: "1" }],
    );
    assert.equal(historyReads, 1);
  },
);

test(
  "offline reads fail closed for missing or malformed principal and row bindings",
  async () => {
    let reads = 0;
    const service = offlineService({
      get: async () => {
        reads++;
        return structuredClone(row);
      },
    });

    for (const principal of [
      session(undefined),
      session(560048),
      session("0560048"),
      { ...session("560048"), wallet: "invalid" },
      { ...session("560048"), expiresAt: Number.NaN },
      { ...session("560048"), expiresAt: 1000 },
    ])
      await assert.rejects(
        service.getIntent(principal, "op"),
        /AUTHENTICATED_SESSION_REQUIRED/,
      );
    assert.equal(reads, 0);

    const malformedRows = [
      { ...row, request: { ...row.request, execution: undefined } },
      { ...row, request: { ...row.request, intent: { wallet: null } } },
      { ...row, id: "different" },
    ];
    for (const badRow of malformedRows)
      await assert.rejects(
        offlineService({ get: async () => badRow }).getIntent(
          session("560048"),
          "op",
        ),
        /OPERATION_NOT_FOUND/,
      );
  },
);

test(
  "offline reads recheck the captured principal after asynchronous storage access",
  async () => {
    const current = session("560048");
    let historyReads = 0;
    const service = offlineService({
      get: async () => {
        current.chainId = "1";
        return structuredClone(row);
      },
      listEvents: async () => {
        historyReads++;
        return [];
      },
    });

    await assert.rejects(
      service.getIntent(current, "op"),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
    assert.equal(historyReads, 0);
  },
);

test(
  "offline history rechecks the principal after the event read",
  async () => {
    const current = session("560048");
    const service = offlineService({
      listEvents: async () => {
        current.chainId = "1";
        return [{ id: "1" }];
      },
    });

    await assert.rejects(
      service.getHistory(current, "op", {}),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
  },
);
