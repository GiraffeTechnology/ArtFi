import assert from "node:assert/strict";
import { test } from "node:test";
import { installedBrowserLaunchOptions } from "./installable-browser-check.mjs";
import {
  archiveRoot,
  expectedChecksum,
  parseArguments,
  summaryStatus,
} from "./installable-acceptance.mjs";

const input = [
  "--artifact",
  "/delivery/artfi-example.tar.gz",
  "--checksum",
  "/delivery/artfi-example.tar.gz.sha256",
  "--mysql-basedir",
  "/opt/mysql",
  "--evidence-dir",
  "/private/acceptance-unique",
];

test("installed-browser acceptance always retains Chromium sandboxing", () => {
  assert.deepEqual(installedBrowserLaunchOptions(), {
    headless: true,
    chromiumSandbox: true,
  });
  assert.deepEqual(installedBrowserLaunchOptions("/test/chromium"), {
    executablePath: "/test/chromium",
    headless: true,
    chromiumSandbox: true,
  });
});

test("explicit artifact and MySQL inputs have no machine-specific fallback", () => {
  const options = parseArguments(input);
  assert.equal(options.artifact, "/delivery/artfi-example.tar.gz");
  assert.equal(options["expected-migrations"], 14);
  assert.equal(options["mysql-library-path"], undefined);
  assert.throws(() => parseArguments([]), /Required option/);
});

test("help does not need an artifact or touch services", () => {
  assert.deepEqual(parseArguments(["--help"]), { help: true });
});

test("unknown, duplicate and valueless options are rejected", () => {
  assert.throws(() => parseArguments([...input, "--production"]), /Unknown/);
  assert.throws(
    () => parseArguments([...input, "--artifact", "/different"]),
    /repeated/,
  );
  assert.throws(
    () => parseArguments([...input, "--mysql-client"]),
    /Missing value/,
  );
});

test("migration denominator is explicit and positive", () => {
  assert.equal(
    parseArguments([...input, "--expected-migrations", "15"])[
      "expected-migrations"
    ],
    15,
  );
  for (const count of ["0", "-1", "14.5", "unknown"])
    assert.throws(
      () => parseArguments([...input, "--expected-migrations", count]),
      /positive integer/,
    );
});

test("required browser coverage cannot silently omit browser tooling", () => {
  assert.throws(
    () => parseArguments([...input, "--require-browser"]),
    /requires --playwright-module/,
  );
  assert.throws(
    () => parseArguments([...input, "--chromium-executable", "/opt/chromium"]),
    /requires --playwright-module/,
  );
  assert.equal(
    parseArguments([
      ...input,
      "--playwright-module",
      "/opt/playwright/index.mjs",
      "--require-browser",
    ])["require-browser"],
    true,
  );
});

test("archive listing must contain one release directory", () => {
  assert.equal(
    archiveRoot(
      "artfi-example/\nartfi-example/manifest.json\nartfi-example/runtime/bin/node\n",
    ),
    "artfi-example",
  );
  for (const listing of [
    "",
    "one/a\ntwo/b\n",
    "../outside\n",
    "/outside\n",
    "artfi/../../outside\n",
  ])
    assert.throws(() => archiveRoot(listing));
});

test("checksum sidecar binds the exact archive filename", () => {
  const hash = "a".repeat(64);
  assert.equal(
    expectedChecksum(`${hash}  artfi-example.tar.gz\n`, "artfi-example.tar.gz"),
    hash,
  );
  assert.equal(
    expectedChecksum(
      `${hash.toUpperCase()} *artfi-example.tar.gz\n`,
      "artfi-example.tar.gz",
    ),
    hash,
  );
  assert.throws(() =>
    expectedChecksum(`${hash}  another.tar.gz`, "artfi-example.tar.gz"),
  );
  assert.throws(() =>
    expectedChecksum(
      `${hash}  artfi-example.tar.gz\n${hash}  other`,
      "artfi-example.tar.gz",
    ),
  );
});

test("report distinguishes failure, incomplete required checks, and scoped pass", () => {
  assert.equal(
    summaryStatus([
      { result: "PASSED", required: true },
      { result: "NOT_RUN", required: false },
    ]),
    "PASSED",
  );
  assert.equal(
    summaryStatus([{ result: "NOT_RUN", required: true }]),
    "NOT_RUN",
  );
  assert.equal(
    summaryStatus([
      { result: "FAILED", required: true },
      { result: "NOT_RUN", required: true },
    ]),
    "FAILED",
  );
});
