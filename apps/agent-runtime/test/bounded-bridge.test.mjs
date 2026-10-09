import test from "node:test";
import assert from "node:assert/strict";
import { actionFixture, ethers } from "./action-fixtures.mjs";
import { createBoundedNativeOrderPublisher } from "../../../scripts/agent/bounded-native-order-publisher.mjs";
import {
  createArtFiBoundedAdapter,
  createWalletBoundedClient,
} from "../../../scripts/agent/wallet-bounded-adapter.mjs";

// These transports are synthetic. No service is mounted, grant created or transaction sent.
const address = (digit) => `0x${digit.repeat(40)}`;
function publisherFixture(mode = "BOUNDED_SERVICE_RELAY") {
  const record = {
    account: address("1"),
    owner: address("2"),
    chainId: 560048,
    order: {
      intentHash: ethers.id("TEST_ONLY_ORDER"),
      chainId: 560048,
      marketAddress: address("3"),
    },
    publication: { state: "UNPUBLISHED" },
  };
  let attempted = false,
    found = null,
    posts = 0,
    loseAck = false,
    proofFails = false;
  const ledger = {
    get: () => record,
    beginPublication: () => {
      const firstAttempt = !attempted;
      attempted = true;
      return { firstAttempt };
    },
    markPublication: (_key, body) => {
      assert.equal(body.intentHash, record.order.intentHash);
      record.publication.state = "PUBLISHED";
      return structuredClone(record);
    },
    unknownPublication: () => {
      record.publication.state = "UNKNOWN";
    },
  };
  const requests = [];
  const chain = {
    config: {
      account: record.account,
      owner: record.owner,
      chainId: record.chainId,
    },
    envelopeSHA256: () => "test-only-digest",
    verifyBoundedOrder: async () => {
      if (proofFails) throw Error("TEST_ONLY_PROOF_REFUSED");
      return { block: 12 };
    },
    recheckCanonicalBlock: async (block) => assert.equal(block, 12),
  };
  const request = async (input) => {
    requests.push(input);
    if (input.method === "GET")
      return found ? { status: 200, body: found } : { status: 404 };
    posts++;
    found = record.order;
    if (loseAck) throw Error("TEST_ONLY_ACK_LOST");
    return { status: 201, body: found };
  };
  return {
    record,
    requests,
    posts: () => posts,
    loseAck: () => {
      loseAck = true;
    },
    failProof: () => {
      proofFails = true;
    },
    forgetReadback: () => {
      found = null;
    },
    publisher: createBoundedNativeOrderPublisher({
      chain,
      ledger,
      request,
      mode,
    }),
  };
}
for (const mode of ["OWNER_SESSION", "BOUNDED_SERVICE_RELAY"]) {
  test(`bounded publication preserves ${mode} transport and never claims settlement`, async () => {
    const f = publisherFixture(mode),
      result = await f.publisher.publish("record");
    assert.equal(result.settlement, false);
    assert.equal(f.posts(), 1);
    const post = f.requests.find((r) => r.method === "POST");
    assert.equal(
      post.path,
      mode === "OWNER_SESSION"
        ? "/v1/indexer/bounded-signed-orders"
        : "/v1/indexer/bounded-order-relay/v1",
    );
    if (mode === "BOUNDED_SERVICE_RELAY")
      assert.deepEqual(Object.keys(JSON.parse(post.body)).sort(), [
        "action",
        "order",
        "schema",
      ]);
  });
}
test("bounded lost acknowledgement recovers exact readback without another publication", async () => {
  const f = publisherFixture();
  f.loseAck();
  await assert.rejects(f.publisher.publish("record"), /ACK_LOST/);
  const result = await f.publisher.publish("record");
  assert.equal(result.recovered, true);
  assert.equal(result.settlement, false);
  assert.equal(f.posts(), 1);
});
test("bounded unknown publication without readback never resends", async () => {
  const f = publisherFixture();
  f.loseAck();
  await assert.rejects(f.publisher.publish("record"), /ACK_LOST/);
  f.forgetReadback();
  assert.equal((await f.publisher.publish("record")).state, "UNKNOWN");
  assert.equal(f.posts(), 1);
});
test("bounded publication refuses unavailable proof before a write", async () => {
  const f = publisherFixture();
  f.failProof();
  await assert.rejects(f.publisher.publish("record"), /PROOF_REFUSED/);
  assert.equal(f.posts(), 0);
});
test("bounded publication account mismatch cannot read or publish", async () => {
  const f = publisherFixture();
  f.record.account = address("4");
  await assert.rejects(f.publisher.publish("record"), /ORDER_NOT_FOUND/);
  assert.equal(f.requests.length, 0);
});
test("bounded client rejects production mode and malformed identifiers without fallback", async () => {
  let calls = 0;
  const client = createWalletBoundedClient({
    request: async () => {
      calls++;
      return {
        status: 200,
        body: {
          protocol: "8415-bounded-trading/1",
          mode: "PRODUCTION",
          result: {},
        },
      };
    },
  });
  await assert.rejects(client.capabilities(), /UNAVAILABLE/);
  assert.throws(() => client.get("../other"), /ID_INVALID/);
  assert.throws(() => client.recover("valid", "bad-hash"), /RECOVERY_INVALID/);
  assert.equal(calls, 1);
});
async function adapterFixture() {
  const fixture = await actionFixture();
  const input = fixture.compile({
    ...(await fixture.order()),
    quantity: "2",
  }).request;
  const owner = fixture.seller.address,
    account = fixture.user.address,
    chainId = "560048",
    mandateId = ethers.id("TEST_ONLY_MANDATE");
  const session = {
    authenticated: true,
    wallet: owner,
    chainId,
    expiresAt: Date.now() + 60000,
  };
  let plan,
    mutate = () => {},
    enqueued = 0;
  const client = {
    capabilities: async () => ({
      productionReady: false,
      autonomousWithinGrantedMandate: true,
      owner,
      account,
      chainId,
    }),
    inspectMandate: async () => ({ owner, account, chainId, revoked: false }),
    enqueue: async () => {
      enqueued++;
      const leg = plan.legs[0];
      const row = {
        id: plan.operationId,
        owner,
        account,
        chainId,
        mandateId,
        payload: {
          callHash: leg.callHash,
          orderHash: leg.orderKey,
          payment: leg.value,
          quantity: leg.quantity,
          asset: leg.asset.contract,
          tokenId: leg.asset.tokenId,
          request: plan.request,
        },
      };
      mutate(row);
      return row;
    },
  };
  const adapter = createArtFiBoundedAdapter({
    ethers,
    client,
    owner,
    account,
    chainId,
    mandateId,
  });
  plan = (await adapter.prepare(session, input)).plan;
  return {
    adapter,
    session,
    input,
    mutate: (f) => {
      mutate = f;
    },
    enqueued: () => enqueued,
  };
}
test("bounded adapter compiles and binds against the retained current kernel and action plan", async () => {
  const f = await adapterFixture();
  const row = await f.adapter.enqueue(f.session, f.input);
  assert.equal(row.id, f.input.operationId);
  assert.equal(f.enqueued(), 1);
});
test("bounded adapter rejects returned quantity widening", async () => {
  const f = await adapterFixture();
  f.mutate((row) => {
    row.payload.quantity = "99";
  });
  await assert.rejects(
    f.adapter.enqueue(f.session, f.input),
    /RESPONSE_BINDING_REFUSED/,
  );
});
test("bounded adapter invalidates a session that expires during asynchronous enqueue", async () => {
  const f = await adapterFixture();
  f.mutate(() => {
    f.session.expiresAt = 0;
  });
  await assert.rejects(
    f.adapter.enqueue(f.session, f.input),
    /OWNER_SESSION_REQUIRED/,
  );
});
test("bounded adapter refuses unauthenticated owners before enqueue", async () => {
  const f = await adapterFixture();
  f.session.authenticated = false;
  await assert.rejects(
    f.adapter.enqueue(f.session, f.input),
    /OWNER_SESSION_REQUIRED/,
  );
  assert.equal(f.enqueued(), 0);
});
