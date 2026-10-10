import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeReport } from "./conditional-browser-summary.mjs";

function report() {
  return {
    errors: [],
    stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [
      {
        specs: [
          {
            file: "e2e/agent-runtime-live.spec.ts",
            tests: ["desktop-chromium", "mobile-chromium"].map(
              (projectName) => ({
                projectName,
                expectedStatus: "passed",
                status: "expected",
                results: [{ status: "passed", retry: 0 }],
              }),
            ),
          },
        ],
      },
    ],
  };
}

test("conditional evidence requires exactly two first-attempt passes", () => {
  assert.equal(summarizeReport(report()).result, "PASSED");
  assert.equal(summarizeReport(null).result, "NOT_RUN");
  assert.equal(summarizeReport(report(), "wrong.spec.ts").result, "FAILED");
  for (const status of ["skipped", "failed", "timedOut", "interrupted"]) {
    const value = report();
    value.suites[0].specs[0].tests[0].results[0].status = status;
    assert.equal(summarizeReport(value).result, "FAILED");
  }
  for (const key of ["skipped", "flaky", "unexpected"]) {
    const value = report();
    value.stats[key] = 1;
    assert.equal(summarizeReport(value).result, "FAILED");
  }
  const retried = report();
  retried.suites[0].specs[0].tests[0].results[0].retry = 1;
  assert.equal(summarizeReport(retried).result, "FAILED");
  const duplicate = report();
  duplicate.suites[0].specs[0].tests.push(
    duplicate.suites[0].specs[0].tests[0],
  );
  assert.equal(summarizeReport(duplicate).result, "FAILED");
});

test("public summary omits report errors, environment and attachments", () => {
  const value = report();
  value.errors.push({ message: "PRIVATE_TEST_TOKEN" });
  value.config = { environment: "PRIVATE_TEST_CONFIGURATION" };
  value.suites[0].specs[0].tests[0].results[0].attachments = [
    { path: "/private/test-password" },
  ];
  const summary = summarizeReport(value);
  assert.equal(summary.result, "FAILED");
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|private|test-password/);
});
