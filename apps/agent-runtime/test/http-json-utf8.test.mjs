import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readRequestJSON, readResponseJSON } from "../src/http-json.mjs";
const damaged = () =>
  Buffer.concat([
    Buffer.from('{"description":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
function request(chunks, headers = {}) {
  const r = Readable.from(chunks);
  r.headers = { "content-type": "application/json", ...headers };
  return r;
}
function response(chunks, headers = {}) {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    }),
    { headers },
  );
}
test("Agent requests reject malformed UTF8 rather than silently changing a JSON string", async () => {
  await assert.rejects(
    readRequestJSON(request([damaged()])),
    /^Error: REQUEST_JSON_INVALID$/,
  );
});
test("Agent upstream replies reject malformed UTF8 rather than substituting a replacement character", async () => {
  await assert.rejects(
    readResponseJSON(response([damaged()])),
    /^Error: UPSTREAM_RESPONSE_INVALID$/,
  );
});
for (const [name, bytes] of [
  ["truncated sequence", [0xe2, 0x82]],
  ["overlong sequence", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
]) {
  test(`Agent rejects ${name} in request and upstream JSON strings`, async () => {
    const body = Buffer.concat([
      Buffer.from('{"description":"'),
      Buffer.from(bytes),
      Buffer.from('"}'),
    ]);
    await assert.rejects(
      readRequestJSON(request([body])),
      /REQUEST_JSON_INVALID/,
    );
    await assert.rejects(
      readResponseJSON(response([body])),
      /UPSTREAM_RESPONSE_INVALID/,
    );
  });
}
test("valid multibyte characters split across chunks retain exact request and response facts", async () => {
  const value = {
    description: "日本語 한글 é",
    tokenId: "9007199254740993",
    price: "123456789012345678901234567890",
  };
  const body = Buffer.from(JSON.stringify(value));
  const chunks = [...body].map((b) => Buffer.from([b]));
  assert.deepEqual(await readRequestJSON(request(chunks)), value);
  assert.deepEqual(await readResponseJSON(response(chunks)), value);
});
test("an explicitly encoded replacement character is valid UTF8 and remains unchanged", async () => {
  const value = { description: "\ufffd" };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.deepEqual(await readRequestJSON(request([bytes])), value);
  assert.deepEqual(await readResponseJSON(response([bytes])), value);
});
test("request and response size boundaries count bytes before decoding", async () => {
  const value = { description: "é" };
  const bytes = Buffer.from(JSON.stringify(value));
  assert.deepEqual(
    await readRequestJSON(request([bytes]), bytes.length),
    value,
  );
  assert.deepEqual(
    await readResponseJSON(response([bytes]), bytes.length),
    value,
  );
  await assert.rejects(
    readRequestJSON(request([bytes]), bytes.length - 1),
    /REQUEST_TOO_LARGE/,
  );
  await assert.rejects(
    readResponseJSON(response([bytes]), bytes.length - 1),
    /UPSTREAM_RESPONSE_TOO_LARGE/,
  );
});
test("declared byte refusals and required JSON request content type retain their codes", async () => {
  await assert.rejects(
    readRequestJSON(
      request([Buffer.from("{}")], { "content-length": "32769" }),
    ),
    /REQUEST_TOO_LARGE/,
  );
  await assert.rejects(
    readResponseJSON(
      response([Buffer.from("{}")], { "content-length": "65537" }),
    ),
    /UPSTREAM_RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(
    readRequestJSON(
      request([Buffer.from("{}")], { "content-type": "text/html" }),
    ),
    /JSON_CONTENT_TYPE_REQUIRED/,
  );
});
test("invalid JSON and non-object requests expose only stable codes", async () => {
  for (const text of ['{"PRIVATE_BAD_JSON":', "null", "[]", "42"]) {
    await assert.rejects(
      readRequestJSON(request([Buffer.from(text)])),
      /^Error: REQUEST_JSON_INVALID$/,
    );
  }
  await assert.rejects(
    readResponseJSON(response([Buffer.from("PRIVATE_BAD_JSON")])),
    /^Error: UPSTREAM_RESPONSE_INVALID$/,
  );
});

test(
  "declared-size rejection settles even when unread-body cancellation never settles",
  { timeout: 1000 },
  async () => {
    let cancelled = 0;
    const body = new ReadableStream({
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
    });
    await assert.rejects(
      readResponseJSON(
        new Response(body, { headers: { "content-length": "65537" } }),
      ),
      /^Error: UPSTREAM_RESPONSE_TOO_LARGE$/,
    );
    assert.equal(cancelled, 1);
  },
);
test(
  "streamed-size rejection settles and releases the reader when cancellation never settles",
  { timeout: 1000 },
  async () => {
    let cancelled = 0;
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled++;
        return new Promise(() => {});
      },
    });
    await assert.rejects(
      readResponseJSON(new Response(body)),
      /^Error: UPSTREAM_RESPONSE_TOO_LARGE$/,
    );
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  },
);
test("cancellation errors cannot replace stable declared and streamed size refusals", async () => {
  for (const declared of [true, false]) {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(65537));
      },
      cancel() {
        throw Error("PRIVATE_CANCEL_FAILURE");
      },
    });
    await assert.rejects(
      readResponseJSON(
        new Response(body, {
          headers: declared ? { "content-length": "65537" } : {},
        }),
      ),
      /^Error: UPSTREAM_RESPONSE_TOO_LARGE$/,
    );
  }
});
