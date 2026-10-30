import test from "node:test";
import assert from "node:assert/strict";
import { createOfflineReadService } from "../src/composition.mjs";

const wallet = "0x" + "ab".repeat(20);
const otherWallet = "0x" + "cd".repeat(20);
const session = (chainId = "560048") => ({
  authenticated: true,
  wallet,
  chainId,
  expiresAt: 2000,
});
const row = (chainId = "560048") => ({
  id: "owned-intent",
  state: "PREPARED",
  request: {
    intent: { wallet, nonce: "1" },
    execution: { chainId, executor: otherWallet },
    sale: { nft: otherWallet, tokenId: "1" },
  },
});
const history = { after: "0", limit: 10 };

function fixture({
  value = row(),
  onGet = () => {},
  onEvents = () => {},
} = {}) {
  const calls = { get: 0, events: 0 };
  const service = createOfflineReadService(
    {
      get: async () => {
        calls.get++;
        onGet();
        return value;
      },
      listEvents: async () => {
        calls.events++;
        onEvents();
        return [{ id: "1", state: "PREPARED" }];
      },
    },
    () => 1000,
  );
  return { service, calls };
}

test("offline reads preserve each matching chain", async () => {
  for (const chainId of ["560048", "1", "8453"]) {
    const f = fixture({ value: row(chainId) });
    const result = await f.service.getIntent(session(chainId), "owned-intent");
    assert.equal(result.asset.chainId, chainId);
    assert.equal(result.execution.state, "PREPARED");
    assert.equal(
      (await f.service.getHistory(session(chainId), "owned-intent", history))
        .events[0].id,
      "1",
    );
  }
});

test("offline reads refuse a different stored chain or owner", async () => {
  for (const value of [
    row("1"),
    row("8453"),
    { ...row(), id: "another-intent" },
    { ...row(), request: { ...row().request, execution: undefined } },
    { ...row(), request: { ...row().request, execution: { chainId: 560048 } } },
    {
      ...row(),
      request: { ...row().request, intent: { wallet: otherWallet } },
    },
    { ...row(), request: { ...row().request, intent: { wallet: 42 } } },
  ]) {
    const f = fixture({ value });
    await assert.rejects(
      f.service.getIntent(session(), "owned-intent"),
      /OPERATION_NOT_FOUND/,
    );
    await assert.rejects(
      f.service.getHistory(session(), "owned-intent", history),
      /OPERATION_NOT_FOUND/,
    );
    assert.equal(f.calls.events, 0);
  }
});

test("invalid offline principals stop before store access", async () => {
  for (const patch of [
    { authenticated: false },
    { wallet: "invalid" },
    { chainId: undefined },
    { chainId: 560048 },
    { chainId: "0560048" },
    { expiresAt: undefined },
    { expiresAt: NaN },
    { expiresAt: 1000 },
  ]) {
    const f = fixture();
    const invalid = { ...session(), ...patch };
    await assert.rejects(
      f.service.getIntent(invalid, "owned-intent"),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
    await assert.rejects(
      f.service.getHistory(invalid, "owned-intent", history),
      /AUTHENTICATED_SESSION_REQUIRED/,
    );
    assert.equal(f.calls.get, 0);
  }
});

test("offline reads recheck after the store await", async () => {
  for (const patch of [
    { wallet: otherWallet },
    { chainId: "1" },
    { expiresAt: 1000 },
  ]) {
    const current = session();
    const f = fixture({ onGet: () => Object.assign(current, patch) });
    await assert.rejects(
      f.service.getIntent(current, "owned-intent"),
      /SESSION_IDENTITY_CHANGED|AUTHENTICATED_SESSION_REQUIRED/,
    );
  }
});

test("offline history rechecks after loading events", async () => {
  for (const patch of [
    { wallet: otherWallet },
    { chainId: "8453" },
    { expiresAt: 1000 },
  ]) {
    const current = session();
    const f = fixture({ onEvents: () => Object.assign(current, patch) });
    await assert.rejects(
      f.service.getHistory(current, "owned-intent", history),
      /SESSION_IDENTITY_CHANGED|AUTHENTICATED_SESSION_REQUIRED/,
    );
    assert.equal(f.calls.events, 1);
  }
});

test("invalid clocks stop before store access", async () => {
  let reads = 0;
  const service = createOfflineReadService(
    {
      get: async () => {
        reads++;
        return row();
      },
    },
    () => NaN,
  );
  await assert.rejects(
    service.getIntent(session(), "owned-intent"),
    /AUTHENTICATED_SESSION_REQUIRED/,
  );
  assert.equal(reads, 0);
});
