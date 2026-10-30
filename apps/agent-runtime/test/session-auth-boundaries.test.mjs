import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createSessionAuthenticator } from "../src/auth.mjs";
const agent = "TEST_ONLY_agent_" + "a".repeat(32),
  user = "TEST_ONLY_user_" + "b".repeat(32),
  access = "TEST_ONLY_access_" + "c".repeat(32);
const request = () => ({
  headers: {
    authorization: `Bearer ${agent}`,
    "x-artfi-web-origin": "https://artfi.example",
    "x-artfi-user-access": access,
  },
});
const auth = (fetchImpl) =>
  createSessionAuthenticator({
    apiURL: "http://127.0.0.1",
    userAuthBridgeToken: user,
    agentBridgeToken: agent,
    webOrigin: "https://artfi.example",
    fetchImpl,
    clock: () => 1000,
  });
test(
  "session401 refusal does not wait for nonsettling cleanup",
  { timeout: 1000 },
  async () => {
    let cancels = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancels++;
          return new Promise(() => {});
        },
      }),
      { status: 401 },
    );
    await assert.rejects(
      auth(async () => response)(request()),
      /^Error: AUTHENTICATED_SESSION_REQUIRED$/,
    );
    assert.equal(cancels, 1);
  },
);
test("session dependency refusal is not replaced by cleanup errors", async () => {
  const response = new Response(
    new ReadableStream({
      cancel() {
        throw Error("PRIVATE_CANCEL_DETAIL");
      },
    }),
    { status: 500 },
  );
  await assert.rejects(
    auth(async () => response)(request()),
    /^Error: SESSION_DEPENDENCY_UNAVAILABLE$/,
  );
});
test(
  "session deadline settles a fetch implementation which ignores abort and cancels its late response",
  { timeout: 4500 },
  async () => {
    let resolve,
      cancels = 0,
      calls = 0;
    const authenticate = auth(() => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    });
    await assert.rejects(
      authenticate(request()),
      /^Error: SESSION_DEPENDENCY_UNAVAILABLE$/,
    );
    resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancels++;
            return new Promise(() => {});
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await setImmediate();
    assert.equal(calls, 1);
    assert.equal(cancels, 1);
  },
);
test(
  "session deadline interrupts a response stream which ignores abort and releases the reader",
  { timeout: 4500 },
  async () => {
    let cancels = 0,
      calls = 0;
    const body = new ReadableStream({
      cancel() {
        cancels++;
        return new Promise(() => {});
      },
    });
    await assert.rejects(
      auth(async () => {
        calls++;
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      })(request()),
      /^Error: SESSION_DEPENDENCY_UNAVAILABLE$/,
    );
    await setImmediate();
    assert.equal(calls, 1);
    assert.equal(cancels, 1);
    assert.equal(body.locked, false);
  },
);
