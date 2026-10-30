import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { sampleMonitor } from "./monitor.mjs";

const fixture = {
  now: () => 2000000,
  host: () => ({
    freeMemoryBytes: 500,
    totalMemoryBytes: 1000,
    loadPerCPU: 0.1,
  }),
};
const config = () => ({
  format: 1,
  probes: [
    {
      name: "web",
      kind: "http",
      url: "https://monitor.example.test/healthz",
      service: "artfi-web",
    },
  ],
});
const sample = (fetcher, c = config()) =>
  sampleMonitor(c, { ...fixture, fetcher });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function quickly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("SAMPLER_CLEANUP_DID_NOT_SETTLE")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function hangingJSON(text, cancel) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel,
  });
  return new Response(body, {
    headers: { "Content-Type": "application/json" },
  });
}

test("sampler deadline retires ignored fetches and quarantines either late outcome", async () => {
  const resolved = deferred(),
    rejected = deferred();
  const signals = [];
  const pending = [resolved, rejected].map((d) =>
    sample((_, options) => {
      signals.push(options.signal);
      return d.promise;
    }),
  );
  const results = await Promise.all(pending);
  assert.deepEqual(
    results.map((r) => r.probes[0].status),
    ["unavailable", "unavailable"],
  );
  assert.ok(signals.every((signal) => signal.aborted));
  let cancelled = false;
  resolved.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  rejected.reject(Error("SYNTHETIC_PRIVATE_LATE_FAILURE"));
  await new Promise(setImmediate);
  assert.equal(cancelled, true);
  assert.doesNotMatch(JSON.stringify(results), /PRIVATE|monitor\.example/);
});

test("sampler deadline interrupts a body that ignores abort and releases its reader", async () => {
  let cancelled = false,
    observedSignal;
  const response = hangingJSON('{"service":"artfi-web"}', () => {
    cancelled = true;
  });
  const result = await sample((_, options) => {
    observedSignal = options.signal;
    return response;
  });
  assert.equal(result.probes[0].status, "unavailable");
  assert.equal(observedSignal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("sampler RPC response body shares each original three-second request budget", async () => {
  const c = config();
  c.executionZone = "sin";
  c.probes = [
    {
      name: "chain",
      kind: "chain",
      url: "https://rpc.example.test",
      chainId: 560048,
      maxAgeSeconds: 90,
    },
  ];
  const methods = [];
  let blocked;
  const result = await sample((_, options) => {
    const request = JSON.parse(options.body);
    methods.push(request.method);
    assert.equal(options.redirect, "error");
    if (request.method === "eth_chainId")
      return Response.json({ id: 1, result: "0x88bb0" });
    blocked = hangingJSON('{"id":1,"result":', () => {});
    return blocked;
  }, c);
  assert.deepEqual(methods, ["eth_chainId", "eth_getBlockByNumber"]);
  assert.equal(result.probes[0].status, "unavailable");
  assert.equal(blocked.body.locked, false);
});

test("sampler streamed overflow does not await unfinished cancellation", async () => {
  const cleanup = deferred();
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled++;
        return cleanup.promise;
      },
    }),
  );
  try {
    const result = await quickly(sample(async () => response));
    assert.equal(result.probes[0].status, "unavailable");
    assert.equal(cancelled, 1);
    assert.equal(response.body.locked, false);
  } finally {
    cleanup.resolve();
  }
});

test("sampler declared overflow cancels without opening or waiting for a reader", async () => {
  const cleanup = deferred();
  let opened = 0,
    cancelled = 0;
  try {
    const result = await quickly(
      sample(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Length": "65537" }),
        body: {
          getReader() {
            opened++;
            throw Error("Unexpected reader");
          },
          cancel() {
            cancelled++;
            return cleanup.promise;
          },
        },
      })),
    );
    assert.equal(result.probes[0].status, "unavailable");
    assert.equal(opened, 0);
    assert.equal(cancelled, 1);
  } finally {
    cleanup.resolve();
  }
});

test("sampler cleanup exceptions do not replace an otherwise valid response", async () => {
  for (const asynchronous of [false, true]) {
    let read = false,
      released = false;
    const result = await sample(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () =>
            read
              ? { done: true }
              : ((read = true),
                {
                  done: false,
                  value: new TextEncoder().encode('{"service":"artfi-web"}'),
                }),
          cancel() {
            if (asynchronous)
              return Promise.reject(Error("SYNTHETIC_PRIVATE_CLEANUP"));
            throw Error("SYNTHETIC_PRIVATE_CLEANUP");
          },
          releaseLock() {
            released = true;
          },
        }),
      },
    }));
    assert.equal(result.probes[0].status, "ok");
    assert.equal(released, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
  await new Promise(setImmediate);
});

test("sampler invalid UTF-8, malformed JSON and empty bodies never report healthy", async () => {
  const invalid = Buffer.concat([
    Buffer.from('{"service":"artfi-web","detail":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  for (const response of [
    new Response(invalid),
    new Response("SYNTHETIC_PRIVATE_INVALID_JSON"),
    new Response(null),
  ]) {
    const result = await sample(async () => response);
    assert.equal(result.probes[0].status, "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|INVALID_JSON/);
    if (response.body) assert.equal(response.body.locked, false);
  }
});

test("sampler valid split UTF-8 and empty chunks retain successful service validation", async () => {
  const bytes = new TextEncoder().encode(
    '{"service":"artfi-web","detail":"café"}',
  );
  const split = bytes.indexOf(0xc3) + 1;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const part of [
          new Uint8Array(),
          bytes.subarray(0, split),
          new Uint8Array(),
          bytes.subarray(split),
        ])
          controller.enqueue(part);
        controller.close();
      },
    }),
  );
  const result = await sample(async () => response);
  assert.equal(result.probes[0].status, "ok");
  assert.equal(response.body.locked, false);
});

test("sampler preserves the exact 64 KiB limit and refuses the next byte", async () => {
  const empty = JSON.stringify({ service: "artfi-web", detail: "" });
  for (const [size, expected] of [
    [65536, "ok"],
    [65537, "unavailable"],
  ]) {
    const body = JSON.stringify({
      service: "artfi-web",
      detail: "x".repeat(size - Buffer.byteLength(empty)),
    });
    assert.equal(Buffer.byteLength(body), size);
    const result = await sample(async () => new Response(body));
    assert.equal(result.probes[0].status, expected);
  }
});

test("sampler bounds a no-progress reader without accumulating empty chunks", async () => {
  let reads = 0,
    cancelled = false,
    released = false;
  const empty = new Uint8Array();
  const result = await sample(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {
      getReader: () => ({
        async read() {
          reads++;
          return { done: false, value: empty };
        },
        cancel() {
          cancelled = true;
        },
        releaseLock() {
          released = true;
        },
      }),
    },
  }));
  assert.equal(result.probes[0].status, "unavailable");
  assert.ok(reads > 0 && reads <= 65537);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

async function withServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const c = config();
  c.probes[0].url = `http://127.0.0.1:${server.address().port}/healthz`;
  return c;
}

test("sampler actual loopback stalled body times out and closes its owned HTTP request", async (t) => {
  const closed = deferred();
  const c = await withServer(t, (req, res) => {
    req.on("close", closed.resolve);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"service":');
  });
  const result = await sample(fetch, c);
  assert.equal(result.probes[0].status, "unavailable");
  await quickly(closed.promise);
});

test("sampler actual loopback non-OK body is discarded without waiting for EOF", async (t) => {
  const closed = deferred();
  const c = await withServer(t, (req, res) => {
    req.on("close", closed.resolve);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.write("SYNTHETIC_PRIVATE_UNFINISHED_BODY");
  });
  const result = await quickly(sample(fetch, c));
  assert.deepEqual(result.probes, [
    { name: "web", status: "unavailable", httpStatus: 503 },
  ]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /PRIVATE|UNFINISHED_BODY|127\.0\.0\.1/,
  );
  await quickly(closed.promise);
});
