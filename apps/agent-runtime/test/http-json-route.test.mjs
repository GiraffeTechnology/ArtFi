import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAgentHTTPServer } from "../src/transport.mjs";

async function withPreparationServer(body, { authorized = true } = {}) {
  const calls = [],
    session = { id: "TEST_ONLY_json_session" };
  const server = createAgentHTTPServer({
    async authenticate() {
      if (!authorized) throw Error("AGENT_TRANSPORT_UNAUTHORIZED");
      return session;
    },
    getRuntimeStatus: () => ({
      mode: "TEST_ONLY_NO_REAL_VALUE",
      state: "TEST_ONLY",
    }),
    getService: () => ({
      async prepareAction(actual, input) {
        assert.equal(actual, session);
        calls.push(structuredClone(input));
        return { state: "TEST_ONLY_RECEIVED", input };
      },
      async createAction() {
        assert.fail("Preparation must not create an action");
      },
      async execute() {
        assert.fail("A JSON transport test must never execute");
      },
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = "http://127.0.0.1:" + server.address().port;
  const post = (bytes, contentType = "application/json") =>
    fetch(root + "/v1/agent/actions/prepare", {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
    });
  try {
    await body({ post, calls });
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeIdleConnections();
    await closed;
  }
}

test("actual preparation POST preserves valid multilingual JSON and exact integer strings", async () => {
  await withPreparationServer(async ({ post, calls }) => {
    const input = {
      operationId: "TEST_ONLY_JSON",
      description: "日本語 한글 é",
      tokenId: "9007199254740993",
      amount: "123456789012345678901234567890",
    };
    const response = await post(Buffer.from(JSON.stringify(input)));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(await response.json(), {
      state: "TEST_ONLY_RECEIVED",
      input,
    });
    assert.deepEqual(calls, [input]);
  });
});
test("actual preparation POST refuses malformed UTF8 before the business preparation boundary", async () => {
  await withPreparationServer(async ({ post, calls }) => {
    for (const invalid of [
      [255],
      [0xe2, 0x82],
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
    ]) {
      const bytes = Buffer.concat([
        Buffer.from('{"description":"'),
        Buffer.from(invalid),
        Buffer.from('"}'),
      ]);
      const response = await post(bytes);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        code: "REQUEST_JSON_INVALID",
        mode: "TEST_ONLY_NO_REAL_VALUE",
      });
    }
    assert.deepEqual(calls, []);
  });
});
test("actual preparation POST retains size and MIME refusals before preparation", async () => {
  await withPreparationServer(async ({ post, calls }) => {
    const oversized = await post(Buffer.from(" ".repeat(32769)));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).code, "REQUEST_TOO_LARGE");
    const wrongMIME = await post(Buffer.from("{}"), "text/html");
    assert.equal(wrongMIME.status, 400);
    assert.equal((await wrongMIME.json()).code, "JSON_CONTENT_TYPE_REQUIRED");
    assert.deepEqual(calls, []);
  });
});
test("unauthenticated preparation POST cannot reach the business boundary with valid or malformed JSON", async () => {
  await withPreparationServer(
    async ({ post, calls }) => {
      for (const bytes of [Buffer.from("{}"), Buffer.from([255])]) {
        const response = await post(bytes);
        assert.equal(response.status, 401);
        assert.equal(
          (await response.json()).code,
          "AGENT_TRANSPORT_UNAUTHORIZED",
        );
      }
      assert.deepEqual(calls, []);
    },
    { authorized: false },
  );
});
