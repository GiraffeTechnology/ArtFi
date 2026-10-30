import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeReport } from "./conditional-browser-summary.mjs";

const agentFile = "agent-runtime-live.spec.ts";
const charityFile = "charity-editions-populated.spec.ts";
const titles = {
  [agentFile]: [
    "real signed session → BFF → durable agent → lost-ack recovery → owner-approved handoff → logout",
  ],
  [charityFile]: [
    "an edition renders the supply the contract reports",
    "charity read failures stay private and retry on /charity",
    "charity read failures stay private and retry on /charity/1",
    "a failed charity refresh removes the earlier edition facts until recovery",
    "a replaced charity facts block stays unavailable until a stable retry",
  ],
};

function report(file = agentFile) {
  return {
    errors: [],
    stats: {
      expected: titles[file].length * 2,
      unexpected: 0,
      flaky: 0,
      skipped: 0,
    },
    suites: [
      {
        specs: titles[file].map((title) => ({
          title,
          file: "e2e/" + file,
          tests: ["desktop-chromium", "mobile-chromium"].map((projectName) => ({
            projectName,
            expectedStatus: "passed",
            status: "expected",
            results: [{ status: "passed", retry: 0 }],
          })),
        })),
      },
    ],
  };
}

test("conditional evidence requires the exact agent two and charity ten first-attempt passes", () => {
  for (const file of [agentFile, charityFile]) {
    const summary = summarizeReport(report(file), file);
    assert.equal(summary.result, "PASSED");
    assert.equal(summary.discovered, titles[file].length * 2);
    assert.deepEqual(
      summary.cases.map((entry) => entry.attempts),
      [titles[file].length, titles[file].length],
    );
  }
  assert.equal(summarizeReport(null).result, "NOT_RUN");
  for (const file of [
    "wrong.spec.ts",
    "constructor",
    "toString",
    "__proto__",
  ]) {
    assert.equal(summarizeReport(report(), file).result, "FAILED");
  }
});

for (const file of [agentFile, charityFile]) {
  test(
    file +
      " rejects failed, skipped, interrupted, retried and malformed attempts",
    () => {
      for (const status of [
        "skipped",
        "failed",
        "timedOut",
        "interrupted",
        "unknown",
      ]) {
        const value = report(file);
        value.suites[0].specs[0].tests[0].results[0].status = status;
        assert.equal(summarizeReport(value, file).result, "FAILED", status);
      }
      for (const key of ["skipped", "flaky", "unexpected"]) {
        const value = report(file);
        value.stats[key] = 1;
        assert.equal(summarizeReport(value, file).result, "FAILED", key);
      }
      for (const mutate of [
        (entry) => {
          entry.results[0].retry = 1;
        },
        (entry) => {
          entry.results.push({ status: "passed", retry: 1 });
        },
        (entry) => {
          entry.results = [];
        },
        (entry) => {
          entry.results = {};
        },
        (entry) => {
          entry.expectedStatus = "skipped";
        },
        (entry) => {
          entry.status = "flaky";
        },
        (entry) => {
          entry.results = [null];
        },
      ]) {
        const value = report(file);
        mutate(value.suites[0].specs[0].tests[0]);
        assert.equal(summarizeReport(value, file).result, "FAILED");
      }
    },
  );
  test(
    file +
      " rejects missing, extra, duplicate or misbound cases even with adjusted counts",
    () => {
      for (const mutate of [
        (value) => {
          value.suites[0].specs[0].tests.pop();
          value.stats.expected--;
        },
        (value) => {
          value.suites[0].specs.pop();
          value.stats.expected -= 2;
        },
        (value) => {
          value.suites[0].specs[0].tests.push({
            ...value.suites[0].specs[0].tests[0],
          });
          value.stats.expected++;
        },
        (value) => {
          value.suites[0].specs[0].title = "unexpected case";
        },
        (value) => {
          value.suites[0].specs[0].file = "wrong.spec.ts";
        },
        (value) => {
          value.suites[0].specs[0].tests[0].projectName = "unapproved-project";
        },
        (value) => {
          value.suites[0].specs.push({ ...value.suites[0].specs[0] });
          value.stats.expected += 2;
        },
      ]) {
        const value = report(file);
        mutate(value);
        assert.equal(summarizeReport(value, file).result, "FAILED");
      }
      if (titles[file].length > 1) {
        const value = report(file);
        value.suites[0].specs[1].title = value.suites[0].specs[0].title;
        assert.equal(summarizeReport(value, file).result, "FAILED");
      }
    },
  );
}

test("public summary omits private report fields on both accepted and rejected reports", () => {
  for (const file of [agentFile, charityFile]) {
    const value = report(file);
    value.config = { environment: "PRIVATE_TEST_CONFIGURATION" };
    value.suites[0].specs[0].tests[0].results[0].attachments = [
      { path: "/private/test-password" },
    ];
    const passed = summarizeReport(value, file);
    assert.equal(passed.result, "PASSED");
    assert.doesNotMatch(
      JSON.stringify(passed),
      /PRIVATE|private|test-password/,
    );
    value.errors.push({ message: "PRIVATE_TEST_TOKEN" });
    const failed = summarizeReport(value, file);
    assert.equal(failed.result, "FAILED");
    assert.doesNotMatch(
      JSON.stringify(failed),
      /PRIVATE|private|test-password/,
    );
  }
});

test("malformed reports fail closed without exposing private values", () => {
  for (const value of [
    { suites: {} },
    { suites: [null] },
    { suites: [{ specs: {} }] },
    { suites: [{ specs: [null] }] },
    { suites: [{ specs: [{ tests: [null] }] }] },
    { ...report(), errors: { message: "PRIVATE_TEST_TOKEN" } },
  ]) {
    const summary = summarizeReport(value);
    assert.equal(summary.result, "FAILED");
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
  }
});
