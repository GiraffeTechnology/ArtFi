import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFixedAdapter, TEST_ADAPTER_CONTRACT } from "../src/adapter.mjs";
import { MODE } from "../src/config.mjs";

// Public test data, never an installed credential or a transaction authority.
const config = {
  kind: "artfi-isolated-test-v1",
  baseURL: "http://127.0.0.1:33228",
  tokenFile: fileURLToPath(
    new URL("./adapter-test-token.txt", import.meta.url),
  ),
};
const envelope = (result) =>
  Response.json({
    contract: TEST_ADAPTER_CONTRACT,
    mode: MODE,
    isolated: true,
    result,
  });
async function adapter(responder) {
  return createFixedAdapter(config, {
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      if (url.endsWith("/policy")) return envelope({ testOnly: true });
      return responder(options);
    },
  });
}
async function outcome(promise, milliseconds = 250) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ state: "resolved", value }),
        (error) => ({ state: "rejected", message: error?.message }),
      ),
      delay(milliseconds, "TEST_CALL_STILL_PENDING", {
        signal: timer.signal,
      }).then((message) => ({ state: "pending", message })),
    ]);
  } finally {
    timer.abort();
  }
}
const unavailable = {
  state: "rejected",
  message: "AGENT_ADAPTER_UNAVAILABLE",
};
function stalledBody(onCancel = () => new Promise(() => {})) {
  return new ReadableStream({
    pull: () => new Promise(() => {}),
    cancel: onCancel,
  });
}

test("non-success response rejects even when cancellation never settles", async () => {
  let cancellations = 0;
  const client = await adapter(
    async () =>
      new Response(
        stalledBody(() => {
          cancellations++;
          return new Promise(() => {});
        }),
        { status: 503 },
      ),
  );
  assert.deepEqual(await outcome(client.observe({})), unavailable);
  assert.equal(cancellations, 1);
});

test("rejected response cleanup cannot expose a private upstream error", async () => {
  const client = await adapter(
    async () =>
      new Response(
        stalledBody(() =>
          Promise.reject(Error("TEST_ONLY_PRIVATE_CLEANUP_DETAILS")),
        ),
        { status: 403 },
      ),
  );
  assert.deepEqual(await outcome(client.observe({})), unavailable);
  await delay(0); // An unhandled cleanup rejection would fail this test process.
});

test("synchronously throwing cleanup still produces the stable adapter refusal", async () => {
  const client = await adapter(async () => ({
    ok: false,
    body: {
      cancel() {
        throw Error("TEST_ONLY_PRIVATE_SYNC_CLEANUP");
      },
    },
  }));
  assert.deepEqual(await outcome(client.observe({})), unavailable);
});

test("external abort interrupts a successful response body that ignores fetch signal", async () => {
  const controller = new AbortController();
  let headers;
  const received = new Promise((resolve) => {
    headers = resolve;
  });
  let cancellations = 0;
  const client = await adapter(async (options) => {
    assert.equal(options.signal.aborted, false);
    headers();
    return new Response(
      stalledBody(() => {
        cancellations++;
        return new Promise(() => {});
      }),
    );
  });
  const pending = client.observe({}, controller.signal);
  await received;
  await delay(0);
  controller.abort(Error("TEST_ONLY_PRIVATE_ABORT_REASON"));
  assert.deepEqual(await outcome(pending), unavailable);
  assert.equal(cancellations, 1);
});

test("already aborted calls cannot return fixture results or leak abort reasons", async () => {
  const controller = new AbortController();
  controller.abort(Error("TEST_ONLY_PRIVATE_ABORT_REASON"));
  const client = await adapter(async () => envelope({ shouldNotBeUsed: true }));
  assert.deepEqual(
    await outcome(client.observe({}, controller.signal)),
    unavailable,
  );
});

test("a cancelled read does not prevent a subsequent independent observation", async () => {
  const controller = new AbortController();
  let first = true;
  const client = await adapter(async () => {
    if (first) {
      first = false;
      return new Response(stalledBody());
    }
    return envelope({ observed: "TEST_ONLY", amount: "9007199254740993" });
  });
  const pending = client.observe({}, controller.signal);
  await delay(0);
  controller.abort();
  assert.deepEqual(await outcome(pending), unavailable);
  assert.deepEqual(await client.observe({}), {
    observed: "TEST_ONLY",
    amount: "9007199254740993",
  });
});

test("ordinary results preserve multilingual content and exact integer strings", async () => {
  const result = { description: "日本語 한글 é", amount: "9007199254740993" };
  const client = await adapter(async () => envelope(result));
  assert.deepEqual(await client.observe({}), result);
});

test("malformed JSON retains its existing stable invalid-response code", async () => {
  const client = await adapter(async () => new Response("TEST_ONLY_NOT_JSON"));
  assert.deepEqual(await outcome(client.observe({})), {
    state: "rejected",
    message: "UPSTREAM_RESPONSE_INVALID",
  });
});

test("oversized responses retain the existing limit and refusal code", async () => {
  const client = await adapter(async () => new Response("x".repeat(65537)));
  assert.deepEqual(await outcome(client.observe({})), {
    state: "rejected",
    message: "UPSTREAM_RESPONSE_TOO_LARGE",
  });
});

test("wrong adapter contracts remain rejected without widening trust", async () => {
  const client = await adapter(async () =>
    Response.json({
      contract: "TEST_ONLY_WRONG_CONTRACT",
      mode: MODE,
      isolated: true,
      result: {},
    }),
  );
  assert.deepEqual(await outcome(client.observe({})), {
    state: "rejected",
    message: "AGENT_ADAPTER_CONTRACT_MISMATCH",
  });
});

test("startup policy body obeys the original four-second deadline", async () => {
  const started = performance.now();
  const pending = createFixedAdapter(config, {
    fetchImpl: async () => new Response(stalledBody()),
  });
  assert.deepEqual(await outcome(pending, 5500), unavailable);
  assert.ok(performance.now() - started >= 3500);
});

test("headers and body share one deadline rather than starting a second timeout", async () => {
  const client = await adapter(async () => {
    await delay(2500);
    return new Response(stalledBody());
  });
  const started = performance.now();
  assert.deepEqual(await outcome(client.observe({}), 5500), unavailable);
  assert.ok(performance.now() - started >= 3500);
});
