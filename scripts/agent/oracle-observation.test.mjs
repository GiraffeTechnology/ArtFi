import test from "node:test";
import assert from "node:assert/strict";
import {
  assertOracleIdentity,
  createOracleApiVerifier,
  createOracleObservation,
} from "./oracle-observation.mjs";
import { createAgentKernel, kernelRequestDigest } from "./agent-kernel.mjs";

// Explicit contract fakes: no live Oracle, signature verification, chain, or database.
const mode = "TEST_ONLY_NO_REAL_VALUE";
const subject = {
  assetId: "fixture-asset",
  chainId: "560048",
  contract: "0x" + "ab".repeat(20),
  tokenId: "1",
  purpose: "fixture-required-flow",
};
const authority = {
  status: "EXCLUSIVE_AT_PINNED_BLOCK",
  productionApproved: false,
  blockNumber: 4,
  blockHash: "fixture-block",
};
const required = {
  attestation: {
    envelope: { subject, attestationId: "fixture-attestation-1" },
  },
  expectedSubject: subject,
};
function adapter({
  resolve = async () => required,
  result = { valid: true, errorCode: null },
  base = async () => ({
    available: true,
    current: true,
    groundingCurrent: true,
    assetRestricted: false,
  }),
} = {}) {
  const wrapped = createOracleObservation({
    mode,
    observe: base,
    resolveRequiredAttestation: resolve,
    verifyAttestation: async (proof, expected, now) => {
      assert.deepEqual(proof, required.attestation);
      assert.deepEqual(expected, subject);
      assert.equal(now.toISOString(), "2026-09-13T00:00:00.000Z");
      return result;
    },
    clock: () => new Date("2026-09-13T00:00:00Z"),
  });
  return (request, signal) =>
    wrapped(
      {
        execution: { chainId: subject.chainId },
        sale: { nft: subject.contract, tokenId: subject.tokenId },
        ...request,
      },
      signal,
    );
}
test("Oracle API verifier posts only the attestation and exact expected subject", async () => {
  let captured;
  const verify = createOracleApiVerifier({
    mode,
    verifyUrl: "https://oracle.example/v1/rwa/attestations/verify",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({ valid: true, errorCode: null }),
      };
    },
  });
  const signal = new AbortController().signal;
  assert.deepEqual(
    await verify(required.attestation, subject, new Date(), signal),
    { valid: true, errorCode: null },
  );
  assert.equal(
    captured.url,
    "https://oracle.example/v1/rwa/attestations/verify",
  );
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.init.signal, signal);
  assert.deepEqual(JSON.parse(captured.init.body), {
    attestation: required.attestation,
    expectedSubject: subject,
  });
});

for (const result of [
  { valid: true, errorCode: null },
  { valid: false, errorCode: "NOT_CURRENT" },
  { valid: false, errorCode: "REVOKED" },
]) {
  test(`Oracle API verifier preserves ${result.errorCode ?? "valid"} verdict`, async () => {
    const verify = createOracleApiVerifier({
      mode,
      verifyUrl: "http://127.0.0.1/v1/rwa/attestations/verify",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => result,
      }),
    });
    assert.deepEqual(await verify(required.attestation, subject), result);
  });
}

for (const [status, code] of [
  [429, "SOURCE_RATE_LIMITED"],
  [503, "SOURCE_UNAVAILABLE"],
]) {
  test(`Oracle API verifier fails closed on HTTP ${status}`, async () => {
    const verify = createOracleApiVerifier({
      mode,
      verifyUrl: "https://oracle.example/v1/rwa/attestations/verify",
      fetchImpl: async () => ({ ok: false, status }),
    });
    await assert.rejects(
      verify(required.attestation, subject),
      new RegExp(code),
    );
  });
}

test("Oracle API verifier rejects malformed success and unsafe endpoint configuration", async () => {
  for (const verifyUrl of [
    "http://oracle.example/v1/rwa/attestations/verify",
    "https://oracle.example/v1/rwa/settlements",
    "https://user:secret@oracle.example/v1/rwa/attestations/verify",
  ])
    assert.throws(
      () =>
        createOracleApiVerifier({
          mode,
          verifyUrl,
          fetchImpl: async () => {},
        }),
      /ORACLE_API_CONFIGURATION_INVALID/,
    );
  const verify = createOracleApiVerifier({
    mode,
    verifyUrl: "https://oracle.example/v1/rwa/attestations/verify",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ valid: true, errorCode: "REVOKED" }),
    }),
  });
  await assert.rejects(
    verify(required.attestation, subject),
    /ATTESTATION_VERIFICATION_FAILED/,
  );
});

function kernelFixture(observe, state = "PREPARED") {
  const request = {
    operationId: "oracle-fixture",
    intent: {},
    execution: { chainId: subject.chainId },
    sale: { nft: subject.contract, tokenId: subject.tokenId },
  };
  let row = {
    id: request.operationId,
    request,
    requestDigest: kernelRequestDigest(request),
    state,
    version: 1,
    leaseToken: "lease",
    leaseExpiresAt: Date.now() + 60000,
  };
  let sends = 0;
  const states = [];
  const run = createAgentKernel({
    mode,
    mintAuthority: async () => authority,
    store: {
      leaseDurationMs: 60000,
      operationTimeoutMs: 1000,
      claim: async () => structuredClone(row),
      release: async () => {},
      renew: async () => {
        row.leaseExpiresAt += 60000;
        return structuredClone(row);
      },
      transition: async (id, version, patch) => {
        assert.equal(version, row.version);
        states.push(patch.state);
        row = { ...row, ...patch, version: version + 1 };
        return structuredClone(row);
      },
    },
    observe,
    authorize: async (_request, observation) => {
      if (
        !observation.available ||
        !observation.current ||
        !observation.groundingCurrent ||
        observation.assetRestricted !== false
      )
        throw Error("STATE_NOT_ELIGIBLE");
      return {
        state: "AUTHORIZED_NOT_EXECUTED",
        intentDigest: "fixture",
        stateVersion: "v1",
        value: "1",
        observedAggregateExposure: "0",
      };
    },
    execute: async () => {
      sends++;
      return {};
    },
    verify: async () => ({ state: "CONFIRMED" }),
    reconcile: async () => ({
      state: "SETTLED",
      canonical: true,
      accountingMatches: true,
    }),
  });
  return {
    run: () => run(request),
    row: () => row,
    states,
    sends: () => sends,
  };
}

test("valid attestation preserves pinned authority and permits existing kernel progression", async () => {
  const f = kernelFixture(adapter());
  assert.equal((await f.run()).state, "SETTLED");
  assert.equal(f.sends(), 1);
  assert.equal(f.row().mintAuthority.blockNumber, 4);
  assert.equal(f.row().oracleAttestation.valid, true);
  assert.equal(
    f.row().oracleAttestation.attestationId,
    "fixture-attestation-1",
  );
  assert.deepEqual(f.row().oracleAttestation.expectedSubject, subject);
});
for (const errorCode of [
  "NOT_CURRENT",
  "REVOKED",
  "SIGNATURE_INVALID",
  "SUBJECT_MISMATCH",
]) {
  test(`${errorCode} stays PREPARED with explicit evidence and never STARTED`, async () => {
    const f = kernelFixture(adapter({ result: { valid: false, errorCode } }));
    assert.equal((await f.run()).state, "SAFE_DEGRADED");
    assert.equal(f.row().state, "PREPARED");
    assert.equal(f.row().oracleAttestation.errorCode, errorCode);
    assert.deepEqual(f.row().oracleAttestation.expectedSubject, subject);
    assert.equal(f.states.includes("STARTED"), false);
    assert.equal(f.sends(), 0);
  });
}
for (const errorCode of [
  "SOURCE_TIMEOUT",
  "SOURCE_CIRCUIT_OPEN",
  "SOURCE_RATE_LIMITED",
]) {
  test(`${errorCode} fails closed before STARTED and recovers on a later healthy read`, async () => {
    let offline = true;
    const f = kernelFixture(
      adapter({
        resolve: async () => {
          if (offline) throw Error(errorCode);
          return required;
        },
      }),
    );
    assert.equal((await f.run()).state, "SAFE_DEGRADED");
    assert.equal(f.row().state, "PREPARED");
    assert.equal(f.row().oracleAttestation.errorCode, errorCode);
    assert.equal(f.row().oracleAttestation.expectedSubject, undefined);
    assert.equal(f.sends(), 0);
    offline = false;
    assert.equal((await f.run()).state, "SETTLED");
    assert.equal(f.sends(), 1);
  });
}
test("trusted null preserves optional unattested flows; request flags cannot bypass resolver", async () => {
  assert.deepEqual(await adapter({ resolve: async () => null })({}), {
    available: true,
    current: true,
    groundingCurrent: true,
    assetRestricted: false,
  });
  const result = await adapter({
    result: { valid: false, errorCode: "REVOKED" },
  })({ requiresAttestation: false });
  assert.equal(result.assetRestricted, true);
});
test("missing binding and malformed verifier success fail closed", async () => {
  assert.equal(
    (await adapter({ resolve: async () => undefined })({})).oracleAttestation
      .errorCode,
    "EXPECTED_SUBJECT_INCOMPLETE",
  );
  for (const result of [
    { valid: "true", errorCode: null },
    { valid: true },
    null,
  ])
    assert.equal((await adapter({ result })({})).groundingCurrent, false);
});
for (const reason of [
  "FROZEN",
  "EXPORT_PERMISSION_DENIED",
  "EXPORT_PURPOSE_INVALID",
]) {
  test(`existing ${reason} refusal cannot become eligible`, async () => {
    const result = await adapter({
      base: async () => ({
        available: true,
        current: true,
        groundingCurrent: false,
        assetRestricted: true,
        reason,
      }),
    })({});
    assert.equal(result.assetRestricted, true);
    assert.equal(result.groundingCurrent, false);
    assert.equal(result.reason, reason);
  });
}
test("STARTED recovery bypasses new attestation checks and never resends", async () => {
  const f = kernelFixture(async () => {
    throw Error("MUST_NOT_RUN");
  }, "STARTED");
  assert.equal((await f.run()).state, "SETTLED");
  assert.equal(f.sends(), 0);
});
test("abort is propagated and never converted into valid evidence", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adapter()({}, controller.signal), {
    name: "AbortError",
  });
});

test("optional flow preserves underlying observation errors", async () => {
  await assert.rejects(
    adapter({
      resolve: async () => null,
      base: async () => {
        throw Error("EXISTING_REFUSAL");
      },
    })({}),
    /EXISTING_REFUSAL/,
  );
});
test("required verdicts map to existing policy fields without replacing mint authority", async () => {
  const valid = await adapter()({});
  assert.equal(valid.groundingCurrent, true);
  const expired = await adapter({
    result: { valid: false, errorCode: "NOT_CURRENT" },
  })({});
  assert.equal(expired.groundingCurrent, false);
  assert.equal(expired.assetRestricted, false);
  const revoked = await adapter({
    result: { valid: false, errorCode: "REVOKED" },
  })({});
  assert.equal(revoked.assetRestricted, true);
  const unavailable = await adapter({
    resolve: async () => {
      throw Error("SOURCE_TIMEOUT");
    },
  })({});
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.current, false);
  assert.equal(Object.hasOwn(valid, "mintAuthority"), false);
});

test("Oracle API verifier rejects a redirected response even from an injected transport", async () => {
  let bodyReads = 0;
  const verify = createOracleApiVerifier({
    mode,
    verifyUrl: "https://oracle.example/v1/rwa/attestations/verify",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      redirected: true,
      json: async () => {
        bodyReads++;
        return { valid: true, errorCode: null };
      },
    }),
  });
  await assert.rejects(
    verify(required.attestation, subject),
    /ATTESTATION_VERIFICATION_FAILED/,
  );
  assert.equal(bodyReads, 0);
});

for (const bodyRejects of [false, true]) {
  test(`Oracle API verifier propagates cancellation during body read (reject=${bodyRejects})`, async () => {
    const controller = new AbortController();
    const verify = createOracleApiVerifier({
      mode,
      verifyUrl: "https://oracle.example/v1/rwa/attestations/verify",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          controller.abort();
          if (bodyRejects) throw Error("BODY_READ_ABORTED");
          return { valid: true, errorCode: null };
        },
      }),
    });
    await assert.rejects(
      verify(required.attestation, subject, new Date(), controller.signal),
      { name: "AbortError" },
    );
  });
}

test("Oracle evidence token identity accepts uint256 max and rejects noncanonical or overflowing IDs", () => {
  const maximum = (1n << 256n) - 1n;
  const check = (tokenId) => {
    const expectedSubject = { ...subject, tokenId };
    return assertOracleIdentity(
      { attestationId: "fixture-attestation-1", expectedSubject },
      {
        execution: { chainId: subject.chainId },
        sale: { nft: subject.contract, tokenId },
      },
    );
  };
  for (const tokenId of ["0", maximum.toString()])
    assert.doesNotThrow(() => check(tokenId));
  for (const tokenId of [
    (maximum + 1n).toString(),
    "9".repeat(78),
    "9".repeat(79),
    "-1",
    "+1",
    "01",
    " 1",
    "1.0",
  ])
    assert.throws(() => check(tokenId), /ORACLE_EVIDENCE_IDENTITY_INVALID/);
});
