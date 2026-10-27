import assert from "node:assert/strict";
import test from "node:test";
import { waitForFinishedJson } from "../../apps/web/src/test/finished-json-response.ts";

test("consumes only a completed matching request, never aborted header evidence", async () => {
  let complete;
  let reads = 0;
  const page = {
    waitForEvent(name, { predicate }) {
      assert.equal(name, "requestfinished");
      return new Promise((resolve) => {
        complete = (request) => {
          if (predicate(request)) resolve(request);
        };
      });
    },
  };
  const result = waitForFinishedJson(
    page,
    (request) => request.url() === "/catalog",
  );
  complete({
    url: () => "/unrelated",
    response: () => {
      throw Error("unrelated");
    },
  });
  complete({
    url: () => "/catalog",
    response: async () => ({
      status: () => 200,
      json: async () => {
        reads++;
        return { data: ["actual"] };
      },
    }),
  });
  assert.deepEqual(await result, { status: 200, body: { data: ["actual"] } });
  assert.equal(reads, 1);
});
test("propagates response-body errors without retries or substitution", async () => {
  let reads = 0;
  const page = {
    waitForEvent: async () => ({
      response: async () => ({
        status: () => 200,
        json: async () => {
          reads++;
          throw Error("body failure");
        },
      }),
    }),
  };
  await assert.rejects(
    waitForFinishedJson(page, () => true),
    /body failure/,
  );
  assert.equal(reads, 1);
});
test("retains failure status and rejects a missing response", async () => {
  const response = {
    status: () => 503,
    json: async () => ({ error: "unavailable" }),
  };
  assert.equal(
    (
      await waitForFinishedJson(
        { waitForEvent: async () => ({ response: async () => response }) },
        () => true,
      )
    ).status,
    503,
  );
  await assert.rejects(
    waitForFinishedJson(
      { waitForEvent: async () => ({ response: async () => null }) },
      () => true,
    ),
    /no response/,
  );
});
