import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// This suite tests store/runtime composition, never cryptography. No external
// crypto package or sibling checkout is needed; signature operations must fail.
const ethers = new Proxy(
  {
    ZeroAddress: "0x" + "00".repeat(20),
    ZeroHash: "0x" + "00".repeat(32),
    isAddress: (value) =>
      typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
    getAddress: (value) => value.toLowerCase(),
    verifyTypedData: () => {
      throw Error("CRYPTO_OUTSIDE_WIRING_TEST");
    },
    AbiCoder: {
      defaultAbiCoder: () => {
        throw Error("CRYPTO_OUTSIDE_WIRING_TEST");
      },
    },
    keccak256: () => {
      throw Error("CRYPTO_OUTSIDE_WIRING_TEST");
    },
    TypedDataEncoder: {
      hash: () => {
        throw Error("CRYPTO_OUTSIDE_WIRING_TEST");
      },
    },
  },
  {
    get(target, key) {
      if (key in target) return target[key];
      throw Error("CRYPTO_OUTSIDE_WIRING_TEST");
    },
  },
);
import { createDurableStore, hydrateOperation } from "./durable-store.mjs";
import { kernelRequestDigest } from "./agent-kernel.mjs";
import { createDurableRuntime } from "./runtime.mjs";
const address = "0x" + "ab".repeat(20),
  hash = "0x" + "12".repeat(32);

test("TEST_ONLY schema uses a MySQL-compatible uint256 decimal encoding", () => {
  const schema = readFileSync(
    new URL("./durable-store.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(schema, /DECIMAL\s*\(\s*78\s*,/i);
  assert.equal(
    schema.match(
      /reserved_value VARCHAR\(78\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/g,
    )?.length,
    2,
  );
});
const servicePolicy = Object.freeze({
  chainId: "560048",
  executor: address,
  collection: address,
  paymentToken: address,
  venue: address,
  counterparties: [address],
  allowedCounterpartyPolicy: hash,
  allowedVenuePolicy: hash,
  jurisdictionPolicy: hash,
  settlementPolicy: hash,
});
const request = {
  operationId: "test-1",
  authorityVersion: "v1",
  execution: { chainId: "560048", executor: address },
  intent: {
    wallet: address,
    nonce: "0",
    intentId: hash,
    actionScope: "1",
    maxExecutions: "1",
    maxOpenOrders: "0",
    maxAggregateExposure: "100",
  },
  sale: { nft: address, tokenId: "1", price: "10" },
};
const authority = {
  status: "EXCLUSIVE_AT_PINNED_BLOCK",
  productionApproved: false,
  chainId: "560048",
  nft: address,
  consumer: address,
  policy: address,
  blockNumber: 4,
  blockHash: hash,
  requestedBlockNumber: 4,
  requestedBlockHash: hash,
};
// mysql2 protocol contract fake only; no real SQL, isolation or durability proof.
function fixture(
  state = "PREPARED",
  reservationConflict = false,
  initialExposure = "0",
) {
  const row = {
    operation_id: request.operationId,
    request_json: JSON.stringify(request),
    request_digest: kernelRequestDigest(request),
    record_json: JSON.stringify({
      state,
      ...(state === "STARTED" ? { intentDigest: hash } : {}),
    }),
    version: 1,
    lease_token: state === "STARTED" ? null : "lease-1",
    lease_expires_ms: state === "STARTED" ? 0 : Date.now() + 60000,
  };
  let available = true,
    exposure = initialExposure;
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    destroy: () => {},
    execute: async (sql, p = []) => {
      if (sql.startsWith("SELECT FLOOR")) return [[{ now_ms: Date.now() }]];
      if (sql.startsWith("SELECT *") && sql.includes("operation_id >"))
        return [
          [
            ...(row.operation_id > p[0] &&
            !["SETTLED", "TERMINAL_REJECTED"].includes(
              JSON.parse(row.record_json).state,
            ) &&
            (!row.lease_token || row.lease_expires_ms <= p[1])
              ? [structuredClone(row)]
              : []),
          ],
        ];
      if (sql.startsWith("SELECT *")) return [[structuredClone(row)]];
      if (sql.startsWith("SELECT intent_digest"))
        return [
          [
            ...(JSON.parse(row.record_json).intentDigest
              ? [{ intent_digest: hash }]
              : []),
          ],
        ];
      if (sql.startsWith("SELECT reserved_value"))
        return [[{ reserved_value: exposure }]];
      if (sql.startsWith("INSERT INTO agent_slice_wallet_exposure"))
        return [{ affectedRows: 1 }];
      if (sql.startsWith("INSERT INTO agent_slice_reservations")) {
        if (reservationConflict)
          throw Object.assign(Error("duplicate"), { code: "ER_DUP_ENTRY" });
        assert.equal(p[3], request.operationId);
        assert.equal(p[4], hash);
        assert.equal(p[5], "10");
      } else if (sql.startsWith("UPDATE agent_slice_wallet_exposure")) {
        exposure = p[0];
      } else if (sql.startsWith("UPDATE") && sql.includes("SET record_json")) {
        row.record_json = p[0];
        row.version = p[1];
      } else if (
        sql.startsWith("UPDATE") &&
        sql.includes("SET lease_token = ?")
      ) {
        row.lease_token = p[0];
        row.lease_expires_ms = p[1];
        row.version = p[2];
      } else if (
        sql.startsWith("UPDATE") &&
        sql.includes("SET lease_expires_ms")
      ) {
        row.lease_expires_ms = p[0];
      } else if (
        sql.startsWith("UPDATE") &&
        sql.includes("SET lease_token = NULL")
      ) {
        row.lease_token = null;
        row.lease_expires_ms = 0;
      } else throw Error("UNEXPECTED_TEST_SQL");
      return [{ affectedRows: 1 }];
    },
  };
  return {
    row,
    pool: {
      getConnection: async () => {
        if (!available) throw Error("TEST_DB_UNAVAILABLE");
        return connection;
      },
    },
    setAvailable: (x) => {
      available = x;
    },
  };
}

test("healthy reauthorization at a new observation version can reserve without replacing original intent", async () => {
  const f = fixture();
  const store = createDurableStore({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    pool: f.pool,
  });
  const before = f.row.request_json;
  const started = await store.transition(
    "test-1",
    1,
    {
      state: "STARTED",
      authorityVersion: "v2",
      intentDigest: hash,
      reservedValue: "10",
      observedAggregateExposure: "0",
    },
    "lease-1",
  );
  assert.equal(started.state, "STARTED");
  assert.equal(started.authorityVersion, "v2");
  assert.equal(f.row.request_json, before);
  assert.equal(started.request.authorityVersion, "v1");
});

test("new observation version never bypasses reservation uniqueness or malformed-version refusal", async () => {
  const f = fixture("PREPARED", true);
  const store = createDurableStore({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    pool: f.pool,
  });
  await assert.rejects(
    store.transition(
      "test-1",
      1,
      {
        state: "STARTED",
        authorityVersion: "v2",
        intentDigest: hash,
        reservedValue: "10",
        observedAggregateExposure: "0",
      },
      "lease-1",
    ),
    /AUTHORITY_ALREADY_RESERVED/,
  );
  for (const version of ["", "space invalid", null])
    await assert.rejects(
      store.transition(
        "test-1",
        1,
        {
          state: "STARTED",
          authorityVersion: version,
          intentDigest: hash,
          reservedValue: "10",
          observedAggregateExposure: "0",
        },
        "lease-1",
      ),
      /AUTHORITY_VERSION_REFUSED/,
    );
  assert.equal(hydrateOperation(f.row).state, "PREPARED");
});
test("observed and already-reserved wallet exposure are atomically refused before STARTED", async () => {
  const f = fixture("PREPARED", false, "0"),
    store = createDurableStore({
      mode: "TEST_ONLY_NO_REAL_VALUE",
      pool: f.pool,
    });
  await assert.rejects(
    store.transition(
      "test-1",
      1,
      {
        state: "STARTED",
        authorityVersion: "v2",
        intentDigest: hash,
        reservedValue: "10",
        observedAggregateExposure: "95",
      },
      "lease-1",
    ),
    /EXPOSURE_EXCEEDED/,
  );
  assert.equal(hydrateOperation(f.row).state, "PREPARED");
});

test("a permanently hung acquisition is quarantined without disabling later recovery", async () => {
  const healthy = fixture(),
    pool = {
      calls: 0,
      getConnection() {
        this.calls++;
        return this.calls === 1
          ? new Promise(() => {})
          : healthy.pool.getConnection();
      },
    },
    store = createDurableStore({
      mode: "TEST_ONLY_NO_REAL_VALUE",
      pool,
      operationTimeoutMs: 20,
      cleanupTimeoutMs: 10,
    });
  await assert.rejects(store.get("test-1"), /DURABLE_ACQUIRE_TIMEOUT/);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await store.get("test-1")).id, "test-1");
  assert.equal(pool.calls, 2);
});
test("preflight evidence persists and hydrates, without weakening PREPARED reservation rule", async () => {
  const f = fixture(),
    s = createDurableStore({ mode: "TEST_ONLY_NO_REAL_VALUE", pool: f.pool });
  await s.transition(
    "test-1",
    1,
    { state: "PREPARED", mintAuthority: authority },
    "lease-1",
  );
  assert.deepEqual((await s.get("test-1")).mintAuthority, authority);
  await s.transition(
    "test-1",
    2,
    {
      state: "PREPARED",
      mintAuthority: {
        status: "UNKNOWN",
        reason: "EVIDENCE_REFUSED",
        productionApproved: false,
      },
    },
    "lease-1",
  );
  assert.equal((await s.get("test-1")).mintAuthority.status, "UNKNOWN");
  f.row.record_json = JSON.stringify({ state: "PREPARED", intentDigest: hash });
  await assert.rejects(
    s.transition(
      "test-1",
      3,
      { state: "PREPARED", mintAuthority: authority },
      "lease-1",
    ),
    /PREPARED_HAS_RESERVATION/,
  );
});
test("drifted evidence cannot hydrate; historical state cannot overwrite authority", async () => {
  for (const change of [
    { chainId: "1" },
    { nft: "0x" + "cd".repeat(20) },
    { productionApproved: true },
    { blockHash: "bad" },
    { requestedBlockNumber: 5 },
  ]) {
    const f = fixture();
    f.row.record_json = JSON.stringify({
      state: "PREPARED",
      mintAuthority: { ...authority, ...change },
    });
    assert.throws(
      () => hydrateOperation(f.row),
      /MINT_AUTHORITY_RECORD_INVALID/,
    );
  }
  const f = fixture("STARTED");
  f.row.lease_token = "lease-1";
  f.row.lease_expires_ms = Date.now() + 60000;
  const s = createDurableStore({
    mode: "TEST_ONLY_NO_REAL_VALUE",
    pool: f.pool,
  });
  await assert.rejects(
    s.transition(
      "test-1",
      1,
      { state: "SETTLED", mintAuthority: authority },
      "lease-1",
    ),
    /MINT_AUTHORITY_PATCH_STATE_REFUSED/,
  );
});
test(
  "new runtime survives a hung observer, retries DB outage and reconciles STARTED without execute",
  { timeout: 2000 },
  async () => {
    const f = fixture("STARTED");
    f.setAvailable(false);
    const controller = new AbortController();
    let sends = 0,
      authorityCalls = 0;
    const unused = async () => {
      throw Error("UNEXPECTED_ADAPTER");
    };
    const runtime = createDurableRuntime({
      pool: f.pool,
      kernelOptions: {
        authorize: unused,
        observe: unused,
        execute: async () => {
          sends++;
          throw Error("UNEXPECTED_SEND");
        },
        verify: unused,
        mintAuthority: async () => {
          authorityCalls++;
          throw Error("UNEXPECTED_PREFLIGHT");
        },
        reconcile: async () => ({
          state: "SETTLED",
          canonical: true,
          accountingMatches: true,
        }),
      },
      serviceOptions: {
        ethers,
        policy: servicePolicy,
        planFor: unused,
        observe: unused,
        inspectRevocation: unused,
      },
    });
    let observations = 0;
    await runtime.run({
      signal: controller.signal,
      intervalMs: 10,
      onBatch: (result) => {
        observations++;
        assert.equal(observations, 1);
        assert.equal(result.state, "SAFE_DEGRADED");
        f.setAvailable(true);
        setTimeout(() => controller.abort(), 100);
        return new Promise(() => {});
      },
    });
    assert.equal(observations, 1);
    assert.equal(sends, 0);
    assert.equal(authorityCalls, 0);
    assert.equal(hydrateOperation(f.row).state, "SETTLED");
    assert.equal(f.row.lease_token, null);
  },
);

test("durable runtime scans confirmed revoked PREPARED, persists terminal and excludes next batch", async () => {
  const f = fixture();
  f.row.lease_token = null;
  f.row.lease_expires_ms = 0;
  const revocation = {
    transactionHash: hash,
    wallet: address,
    nonce: "0",
    executor: address,
    chainId: "560048",
    state: "CONFIRMED",
    canonical: true,
  };
  f.row.record_json = JSON.stringify({ state: "PREPARED", revocation });
  let calls = 0;
  const unused = async () => {
    calls++;
    throw Error("UNEXPECTED_ADAPTER");
  };
  const runtime = createDurableRuntime({
    pool: f.pool,
    kernelOptions: {
      authorize: unused,
      observe: unused,
      execute: unused,
      verify: unused,
      mintAuthority: unused,
      reconcile: unused,
    },
    serviceOptions: {
      ethers,
      policy: servicePolicy,
      planFor: unused,
      observe: unused,
      inspectRevocation: unused,
    },
  });
  const batch = await runtime.runBatch();
  assert.equal(batch.outcomes[0].state, "TERMINAL_REJECTED");
  const stored = hydrateOperation(f.row);
  assert.equal(stored.reason, "INTENT_REVOKED");
  assert.deepEqual(stored.revocation, revocation);
  assert.equal(stored.leaseToken, null);
  const next = await runtime.runBatch();
  assert.equal(next.outcomes.length, 0);
  assert.equal(calls, 0);
});

test("durable hydration refuses revoked proof identity corruption before worker execution", async () => {
  for (const change of [
    { nonce: "1" },
    { chainId: "1" },
    { canonical: false },
    { wallet: "0x" + "cd".repeat(20) },
  ]) {
    const f = fixture();
    f.row.record_json = JSON.stringify({
      state: "PREPARED",
      revocation: {
        transactionHash: hash,
        wallet: address,
        nonce: "0",
        executor: address,
        chainId: "560048",
        state: "CONFIRMED",
        canonical: true,
        ...change,
      },
    });
    assert.throws(() => hydrateOperation(f.row), /REVOCATION_RECORD_INVALID/);
  }
});

test("optional Oracle runtime adapter persists rejection evidence through durable hydration", async () => {
  const f = fixture();
  f.row.lease_token = null;
  f.row.lease_expires_ms = 0;
  const unused = async () => {
    throw Error("UNEXPECTED_ADAPTER");
  };
  const runtime = createDurableRuntime({
    pool: f.pool,
    kernelOptions: {
      observe: async () => ({
        available: true,
        current: true,
        groundingCurrent: true,
        assetRestricted: false,
      }),
      authorize: async () => {
        throw Error("STATE_NOT_ELIGIBLE");
      },
      execute: unused,
      verify: unused,
      reconcile: unused,
      mintAuthority: async () => authority,
    },
    oracleAttestation: {
      resolveRequiredAttestation: async () => ({
        attestation: { envelope: { attestationId: "fixture-attestation-1" } },
        expectedSubject: {
          assetId: "test-asset",
          chainId: "560048",
          contract: address,
          tokenId: "1",
          purpose: "test-required-flow",
        },
      }),
      verifyAttestation: async () => ({
        valid: false,
        errorCode: "REVOKED",
      }),
    },
    serviceOptions: {
      ethers,
      policy: servicePolicy,
      planFor: unused,
      observe: async () => ({
        available: true,
        current: true,
        groundingCurrent: true,
        assetRestricted: false,
      }),
      inspectRevocation: unused,
    },
  });
  const result = await runtime.runBatch();
  assert.equal(result.outcomes[0].state, "SAFE_DEGRADED");
  const restored = hydrateOperation(f.row);
  assert.equal(restored.state, "PREPARED");
  assert.equal(restored.mintAuthority.status, "EXCLUSIVE_AT_PINNED_BLOCK");
  assert.equal(restored.oracleAttestation.errorCode, "REVOKED");
  assert.equal(f.row.lease_token, null);
});

test("durable runtime refuses direct SDK composition outside the synthetic compatibility test", () => {
  const f = fixture();
  const unused = async () => {};
  assert.throws(
    () =>
      createDurableRuntime({
        pool: f.pool,
        kernelOptions: {
          observe: unused,
          authorize: unused,
          execute: unused,
          verify: unused,
          reconcile: unused,
          mintAuthority: unused,
        },
        serviceOptions: {
          ethers,
          policy: servicePolicy,
          planFor: unused,
          observe: unused,
          inspectRevocation: unused,
        },
        oracleAttestation: {
          resolveRequiredAttestation: unused,
          attestationService: { verify() {} },
          verifyOracleAttestation: unused,
        },
      }),
    /ORACLE_RUNTIME_API_VERIFIER_REQUIRED/,
  );
});

for (const errorCode of [null, "NOT_CURRENT", "REVOKED"]) {
  test(`durable Oracle ${errorCode ?? "valid"} evidence retains exact identity`, async () => {
    const f = fixture();
    f.row.lease_token = null;
    f.row.lease_expires_ms = 0;
    const store = createDurableStore({
      mode: "TEST_ONLY_NO_REAL_VALUE",
      pool: f.pool,
    });
    const row = await store.claim("test-1", kernelRequestDigest(request));
    const evidence = {
      valid: errorCode === null,
      errorCode,
      checkedAt: "2026-09-13T00:00:00.000Z",
      attestationId: "fixture-attestation-1",
      expectedSubject: {
        assetId: "test-asset",
        chainId: request.execution.chainId,
        contract: request.sale.nft,
        tokenId: request.sale.tokenId,
        purpose: "fixture-required-flow",
      },
    };
    await store.transition(
      row.id,
      row.version,
      { state: "PREPARED", oracleAttestation: evidence },
      row.leaseToken,
    );
    assert.deepEqual(hydrateOperation(f.row).oracleAttestation, evidence);
    for (const change of [
      { attestationId: undefined },
      { attestationId: 123 },
      { attestationId: "a".repeat(129) },
      { expectedSubject: undefined },
      ...[
        { chainId: "1" },
        { contract: "0x" + "cd".repeat(20) },
        { tokenId: "2" },
        { purpose: "" },
        { assetId: "a".repeat(129) },
        { extra: "not-allowed" },
      ].map((fields) => ({
        expectedSubject: { ...evidence.expectedSubject, ...fields },
      })),
    ]) {
      const corrupted = {
        ...f.row,
        record_json: JSON.stringify({
          state: "PREPARED",
          oracleAttestation: { ...evidence, ...change },
        }),
      };
      assert.throws(
        () => hydrateOperation(corrupted),
        /ORACLE_EVIDENCE_IDENTITY_INVALID/,
      );
    }
  });
}
test("source-resolution failure may hydrate without identity but valid may not", () => {
  const f = fixture();
  f.row.record_json = JSON.stringify({
    state: "PREPARED",
    oracleAttestation: { valid: false, errorCode: "SOURCE_TIMEOUT" },
  });
  assert.equal(
    hydrateOperation(f.row).oracleAttestation.errorCode,
    "SOURCE_TIMEOUT",
  );
  f.row.record_json = JSON.stringify({
    state: "PREPARED",
    oracleAttestation: { valid: true, errorCode: null },
  });
  assert.throws(
    () => hydrateOperation(f.row),
    /ORACLE_EVIDENCE_IDENTITY_INVALID/,
  );
});
