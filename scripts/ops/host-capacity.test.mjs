import { test } from "node:test";
import assert from "node:assert/strict";
import { hostCapacityProbe, validateHostCapacity } from "./host-capacity.mjs";
import { validateConfig, serviceProbe } from "./monitor-service.mjs";
import { evaluate } from "./monitor-core.mjs";

const check = () => ({
  id: "host-capacity",
  category: "capacity",
  kind: "host-capacity",
  maxAgeMs: 10000,
  diskPath: "/controlled-test-disk",
});
const configuration = (checks) => ({
  schemaVersion: 1,
  mode: "monitor-only",
  inventoryVerified: true,
  enabled: true,
  environment: "test",
  hostRole: "ctyun-abcdyi",
  stateDirectory: "/controlled-test-state",
  stopFile: "/controlled-test-state/STOP",
  intervalMs: 1000,
  checks,
});
const healthyHost = () => ({
  freeMemoryBytes: 500,
  totalMemoryBytes: 1000,
  loadPerCPU: 0.5,
});
const fixtures = (overrides = {}) => ({
  disk: async () => ({ bavail: 50n, blocks: 100n, bsize: 4096n }),
  host: healthyHost,
  now: () => 10000,
  ...overrides,
});
const observe = (c = check(), options = fixtures(), signal) =>
  hostCapacityProbe([c], options)(c.id, signal);

test("host capacity: explicit deployment path and inherited defaults accept healthy telemetry", async () => {
  const c = check();
  validateConfig(configuration([c]));
  let reads = 0;
  const sample = await observe(
    c,
    fixtures({
      disk: async (path, options) => {
        reads++;
        assert.equal(path, c.diskPath);
        assert.deepEqual(options, { bigint: true });
        return { bavail: 50n, blocks: 100n, bsize: 4096n };
      },
    }),
  );
  assert.equal(reads, 1);
  assert.deepEqual(sample, { available: true, fresh: true, observedAt: 10000 });
  assert.equal(evaluate(sample, 10000, c.maxAgeMs), "healthy");
});

test("host capacity: exact byte floor is inclusive without Number multiplication rounding", async () => {
  const c = { ...check(), minimumFreeDiskBytes: Number.MAX_SAFE_INTEGER };
  const exact = {
    bavail: 1n,
    blocks: 1n,
    bsize: BigInt(Number.MAX_SAFE_INTEGER),
  };
  assert.equal(
    (await observe(c, fixtures({ disk: async () => exact }))).available,
    true,
  );
  assert.equal(
    (
      await observe(
        c,
        fixtures({ disk: async () => ({ ...exact, bsize: exact.bsize - 1n }) }),
      )
    ).available,
    false,
  );
  const large = {
    bavail: BigInt(Number.MAX_SAFE_INTEGER),
    blocks: BigInt(Number.MAX_SAFE_INTEGER),
    bsize: 4096n,
  };
  assert.equal(
    (await observe(c, fixtures({ disk: async () => large }))).available,
    true,
  );
});

test("host capacity: low disk ratio is a fresh unhealthy observation, not a healthy heartbeat", async () => {
  const sample = await observe(
    check(),
    fixtures({
      disk: async () => ({ bavail: 9n, blocks: 100n, bsize: 4096n }),
    }),
  );
  assert.deepEqual(sample, {
    available: false,
    fresh: true,
    observedAt: 10000,
  });
  assert.equal(evaluate(sample, 10000, 10000), "unavailable");
});

test("host capacity: configured disk ratio and byte floor must both pass", async () => {
  assert.equal(
    (await observe({ ...check(), minimumFreeDiskRatio: 0.6 })).available,
    false,
  );
  assert.equal(
    (await observe({ ...check(), minimumFreeDiskBytes: 204801 })).available,
    false,
  );
  assert.equal(
    (
      await observe({
        ...check(),
        minimumFreeDiskRatio: 0.5,
        minimumFreeDiskBytes: 204800,
      })
    ).available,
    true,
  );
});

test("host capacity: low free memory is unhealthy at the inherited threshold", async () => {
  const sample = await observe(
    check(),
    fixtures({ host: () => ({ ...healthyHost(), freeMemoryBytes: 49 }) }),
  );
  assert.equal(sample.available, false);
  assert.equal(sample.fresh, true);
  assert.equal(
    (
      await observe(
        check(),
        fixtures({ host: () => ({ ...healthyHost(), freeMemoryBytes: 50 }) }),
      )
    ).available,
    true,
  );
});

test("host capacity: load per CPU retains the inherited boundary and explicit limit", async () => {
  assert.equal(
    (
      await observe(
        check(),
        fixtures({ host: () => ({ ...healthyHost(), loadPerCPU: 2 }) }),
      )
    ).available,
    true,
  );
  assert.equal(
    (
      await observe(
        check(),
        fixtures({ host: () => ({ ...healthyHost(), loadPerCPU: 2.01 }) }),
      )
    ).available,
    false,
  );
  assert.equal(
    (await observe({ ...check(), maximumLoadPerCPU: 0.4 })).available,
    false,
  );
  assert.equal(
    (await observe({ ...check(), minimumFreeMemoryRatio: 0.6 })).available,
    false,
  );
});

test("host capacity: corrupt or unsupported filesystem counters never become healthy", async () => {
  for (const fs of [
    null,
    {},
    { bavail: 1, blocks: 10n, bsize: 4096n },
    { bavail: -1n, blocks: 10n, bsize: 4096n },
    { bavail: 11n, blocks: 10n, bsize: 4096n },
    { bavail: 1n, blocks: 0n, bsize: 4096n },
    { bavail: 1n, blocks: 10n, bsize: 0n },
    { bavail: 1n, blocks: BigInt(Number.MAX_SAFE_INTEGER) + 1n, bsize: 4096n },
  ]) {
    assert.deepEqual(
      await observe(check(), fixtures({ disk: async () => fs })),
      { available: false, fresh: false, observedAt: 10000 },
    );
  }
});

test("host capacity: invalid memory or load telemetry cannot suppress an alert", async () => {
  for (const data of [
    null,
    { ...healthyHost(), freeMemoryBytes: NaN },
    { ...healthyHost(), totalMemoryBytes: 0 },
    { ...healthyHost(), freeMemoryBytes: 1001 },
    { ...healthyHost(), freeMemoryBytes: -1 },
    { ...healthyHost(), loadPerCPU: Infinity },
    { ...healthyHost(), loadPerCPU: -1 },
  ]) {
    assert.deepEqual(await observe(check(), fixtures({ host: () => data })), {
      available: false,
      fresh: false,
      observedAt: 10000,
    });
  }
});

test("host capacity: failed disk or host reads expose no path or exception text", async () => {
  const secret = "SYNTHETIC_PRIVATE_PATH_OR_DIAGNOSTIC";
  for (const failure of [
    {
      disk: async () => {
        throw Error(secret);
      },
    },
    {
      host: () => {
        throw Error(secret);
      },
    },
  ]) {
    const sample = await observe(check(), fixtures(failure));
    assert.deepEqual(sample, {
      available: false,
      fresh: false,
      observedAt: 10000,
    });
    assert.doesNotMatch(
      JSON.stringify(sample),
      /PRIVATE|DIAGNOSTIC|disk|memory|load/i,
    );
  }
});

test("host capacity: pre-aborted sample performs no filesystem read", async () => {
  const control = new AbortController();
  control.abort();
  let calls = 0;
  await assert.rejects(
    observe(
      check(),
      fixtures({
        disk: async () => {
          calls++;
        },
      }),
      control.signal,
    ),
    /SAMPLE_ABORTED/,
  );
  assert.equal(calls, 0);
});

test("host capacity: cancellation during stat cannot return a successful observation", async () => {
  const control = new AbortController();
  let hostCalls = 0;
  await assert.rejects(
    observe(
      check(),
      fixtures({
        disk: async () => {
          control.abort();
          return { bavail: 50n, blocks: 100n, bsize: 4096n };
        },
        host: () => {
          hostCalls++;
          return healthyHost();
        },
      }),
      control.signal,
    ),
    /SAMPLE_ABORTED/,
  );
  assert.equal(hostCalls, 0);
});

test("host capacity: invalid timestamps are refused", async () => {
  for (const value of [-1, NaN, Infinity, 1.5]) {
    await assert.rejects(
      observe(check(), fixtures({ now: () => value })),
      /CLOCK_REFUSED/,
    );
  }
});

test("host capacity: path, category, unknown fields and invalid thresholds are refused", () => {
  for (const change of [
    { diskPath: undefined },
    { diskPath: "relative" },
    { diskPath: "/bad\npath" },
    { category: "db" },
    { kind: "liveness" },
    { url: "http://127.0.0.1/" },
    { arbitrary: true },
    { minimumFreeDiskRatio: 0 },
    { minimumFreeDiskRatio: 1 },
    { minimumFreeMemoryRatio: NaN },
    { minimumFreeMemoryRatio: 1 },
    { minimumFreeDiskBytes: -1 },
    { minimumFreeDiskBytes: 1.5 },
    { minimumFreeDiskBytes: Number.MAX_SAFE_INTEGER + 1 },
    { maximumLoadPerCPU: 0 },
    { maximumLoadPerCPU: Infinity },
  ]) {
    assert.throws(
      () => validateHostCapacity({ ...check(), ...change }),
      /CONFIG_REFUSED/,
    );
  }
  assert.throws(
    () => validateConfig(configuration([{ ...check(), category: "backup" }])),
    /CONFIG_REFUSED/,
  );
});

test("host capacity: service routes host probes locally without any HTTP dependency", async () => {
  let fetchCalls = 0;
  const probe = serviceProbe([check()], {
    ...fixtures(),
    fetchImpl: async () => {
      fetchCalls++;
      throw Error("Unexpected HTTP");
    },
  });
  assert.deepEqual(await probe("host-capacity"), {
    available: true,
    fresh: true,
    observedAt: 10000,
  });
  assert.equal(fetchCalls, 0);
  await assert.rejects(probe("unknown"), /UNKNOWN_PROBE/);
});

test("host capacity: mixed service inventory retains original HTTP probe semantics", async () => {
  const http = {
    id: "web",
    category: "web",
    kind: "liveness",
    maxAgeMs: 10000,
    url: "http://127.0.0.1:12345/healthz",
  };
  const c = configuration([check(), http]);
  validateConfig(c);
  const calls = [];
  const probe = serviceProbe(c.checks, {
    ...fixtures(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response("ignored");
    },
  });
  assert.equal((await probe("host-capacity")).available, true);
  assert.deepEqual(await probe("web"), {
    available: true,
    observedAt: 10000,
    fresh: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, http.url);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
});

test("host capacity: native read-only filesystem and OS measurement returns only the sanitized schema", async () => {
  const c = { ...check(), diskPath: process.cwd() };
  const sample = await hostCapacityProbe([c])(c.id);
  assert.deepEqual(Object.keys(sample).sort(), [
    "available",
    "fresh",
    "observedAt",
  ]);
  assert.equal(typeof sample.available, "boolean");
  assert.equal(sample.fresh, true);
  assert.equal(Number.isSafeInteger(sample.observedAt), true);
  assert.equal(process.platform, "linux");
});

test("host capacity: caller mutation cannot replace the configured path or thresholds during a read", async () => {
  const c = check();
  const probe = hostCapacityProbe(
    [c],
    fixtures({
      disk: async (path) => {
        assert.equal(path, "/controlled-test-disk");
        c.diskPath = "/other-path";
        c.minimumFreeDiskRatio = 0.001;
        return { bavail: 9n, blocks: 100n, bsize: 4096n };
      },
    }),
  );
  assert.equal((await probe(c.id)).available, false);
});
