import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const projects = ["desktop-chromium", "mobile-chromium"];
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
  const tests = [];
  function visit(suites) {
    for (const suite of suites || []) {
      for (const spec of suite.specs || [])
        for (const test of spec.tests || [])
          tests.push({ ...test, file: spec.file });
      visit(suite.suites);
    }
  }
  visit(report?.suites);
  const cases = projects.map((project) => {
    const matches = tests.filter((test) => test.projectName === project);
    const results = matches.flatMap((test) => test.results || []);
    const passed =
      matches.length === 1 &&
      basename(matches[0].file || "") === expectedFile &&
      matches[0].expectedStatus === "passed" &&
      matches[0].status === "expected" &&
      results.length === 1 &&
      results[0].status === "passed" &&
      results[0].retry === 0;
    return {
      project,
      passed,
      attempts: results.length,
      statuses: results.map((result) =>
        statuses.has(result.status) ? result.status : "unknown",
      ),
    };
  });
  return {
    result:
      report &&
      !(report.errors || []).length &&
      tests.length === 2 &&
      cases.every((entry) => entry.passed) &&
      report.stats?.expected === 2 &&
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
