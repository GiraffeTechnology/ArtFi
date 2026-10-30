import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const projects = ["desktop-chromium", "mobile-chromium"];
const expectedTitlesByFile = {
  "agent-runtime-live.spec.ts": [
    "real signed session → BFF → durable agent → lost-ack recovery → owner-approved handoff → logout",
  ],
  "charity-editions-populated.spec.ts": [
    "an edition renders the supply the contract reports",
    "charity read failures stay private and retry on /charity",
    "charity read failures stay private and retry on /charity/1",
    "a failed charity refresh removes the earlier edition facts until recovery",
  ],
};

const statuses = new Set([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "interrupted",
]);

// Publish only counts and fixed project names, never test errors, attachments,
// request bodies, database configuration, tokens, logs or the raw report.
export function summarizeReport(
  report,
  expectedFile = "agent-runtime-live.spec.ts",
) {
  const expectedTitles = Object.hasOwn(expectedTitlesByFile, expectedFile)
    ? expectedTitlesByFile[expectedFile]
    : undefined;
  const tests = [];
  let malformed = false;
  function visit(suites) {
    if (!Array.isArray(suites)) {
      malformed = true;
      return;
    }
    for (const suite of suites) {
      if (!suite || typeof suite !== "object") {
        malformed = true;
        continue;
      }
      const specs = suite.specs ?? [];
      if (!Array.isArray(specs)) {
        malformed = true;
        continue;
      }
      for (const spec of specs) {
        if (!spec || !Array.isArray(spec.tests)) {
          malformed = true;
          continue;
        }
        for (const test of spec.tests) {
          if (!test || typeof test !== "object") {
            malformed = true;
            continue;
          }
          tests.push({ ...test, file: spec.file, title: spec.title });
        }
      }
      visit(suite.suites ?? []);
    }
  }
  visit(report?.suites ?? []);
  const cases = projects.map((project) => {
    const matches = tests.filter((test) => test.projectName === project);
    const results = matches.flatMap((test) =>
      Array.isArray(test.results) ? test.results : [],
    );
    const passed =
      Boolean(expectedTitles) &&
      matches.length === expectedTitles.length &&
      expectedTitles.every(
        (title) => matches.filter((test) => test.title === title).length === 1,
      ) &&
      matches.every(
        (test) =>
          basename(typeof test.file === "string" ? test.file : "") ===
            expectedFile &&
          test.expectedStatus === "passed" &&
          test.status === "expected" &&
          Array.isArray(test.results) &&
          test.results.length === 1 &&
          test.results[0]?.status === "passed" &&
          test.results[0]?.retry === 0,
      );
    return {
      project,
      passed,
      attempts: results.length,
      statuses: results.map((result) =>
        statuses.has(result?.status) ? result.status : "unknown",
      ),
    };
  });
  const expectedCount = (expectedTitles?.length ?? 0) * projects.length;
  return {
    result:
      report &&
      !malformed &&
      (report.errors === undefined || Array.isArray(report.errors)) &&
      !(report.errors || []).length &&
      tests.length === expectedCount &&
      cases.every((entry) => entry.passed) &&
      report.stats?.expected === expectedCount &&
      report.stats?.unexpected === 0 &&
      report.stats?.flaky === 0 &&
      report.stats?.skipped === 0
        ? "PASSED"
        : report
          ? "FAILED"
          : "NOT_RUN",
    discovered: tests.length,
    cases,
  };
}

async function jsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function main([directory, installedReport, output]) {
  if (!directory || !installedReport || !output)
    throw new Error(
      "Expected private evidence directory, installed report, output",
    );
  let directories = [];
  try {
    directories = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith("artfi-stage2-mysql."),
      )
      .map((entry) => entry.name);
  } catch {}
  const agent =
    directories.length === 1
      ? await jsonIfPresent(
          join(directory, directories[0], "agent-browser.json"),
        )
      : null;
  const charity = await jsonIfPresent(join(directory, "charity-browser.json"));
  const installation = await jsonIfPresent(installedReport);
  const artifact = installation?.artifact;
  const validHash = (value, length) =>
    typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
      ? value
      : null;
  const summary = {
    scope:
      "TEST_ONLY: real local session/BFF/agent/SQL with synthetic authority and adapter; charity mocked JSON-RPC presentation only",
    testedCommit: validHash(process.env.GITHUB_SHA, 40),
    artifact: {
      sha256: validHash(artifact?.sha256, 64),
      sourceRevision: validHash(artifact?.source?.revision, 40),
      sourceFingerprint: validHash(artifact?.source?.fingerprint, 64),
      dirty:
        typeof artifact?.source?.dirty === "boolean"
          ? artifact.source.dirty
          : null,
    },
    chromiumSandboxConfigured: true,
    retriesConfigured: 0,
    agent: summarizeReport(agent, "agent-runtime-live.spec.ts"),
    charity: summarizeReport(charity, "charity-editions-populated.spec.ts"),
  };
  await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  if (
    !summary.artifact.sha256 ||
    !summary.artifact.sourceRevision ||
    !summary.artifact.sourceFingerprint ||
    summary.artifact.dirty !== false ||
    summary.agent.result !== "PASSED" ||
    summary.charity.result !== "PASSED"
  )
    process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || ".")).href)
  await main(process.argv.slice(2));
