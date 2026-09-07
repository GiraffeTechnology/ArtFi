import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const expected =
  '  migration:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Require the approved CTYun database executor\n        run: |\n          echo "CTYUN_DB_EXECUTION_NOT_CONFIGURED: migration acceptance remains blocked."\n          echo "No local MySQL is started. See docs/CTYUN_DATABASE_CI_GATE.md."\n          exit 1';
const workflow = fs.readFileSync(
  fileURLToPath(
    new URL("../../.github/workflows/quality.yml", import.meta.url),
  ),
  "utf8",
);
const compose = fs
  .readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8")
  .replaceAll("\r\n", "\n");

function verifyExplicitNonDatabaseCompose(source) {
  for (const call of source.matchAll(
    /\b(?:docker\s+compose|docker-compose|podman\s+compose)\s+(?:up|start)\b([^\r\n]*)/g,
  )) {
    const tokens = call[1].trim().split(/\s+/).filter(Boolean);
    const options = new Set([
      "-d",
      "--detach",
      "--wait",
      "--no-deps",
      "--no-recreate",
      "--remove-orphans",
    ]);
    const services = tokens.filter((token) => !options.has(token));
    // Bare up/start selects every service, including the root MySQL service.
    // The only audited non-DB service currently in this Compose file is redis.
    assert.ok(
      services.length > 0 && services.every((service) => service === "redis"),
      "Compose startup requires an explicit reviewed non-DB service",
    );
    const block =
      compose.match(
        /^  redis:\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:|^\S|$(?![\s\S]))/m,
      )?.[1] ?? "";
    assert.ok(
      /^    image: redis:8-alpine\s*$/m.test(block) &&
        !/\b(?:depends_on|extends|include):/.test(block) &&
        !/^include:/m.test(compose),
      "redis dependency graph needs renewed non-DB review",
    );
  }
}

function verifyBoundary(source) {
  verifyExplicitNonDatabaseCompose(source);
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const starts = lines.flatMap((line, index) =>
    line === "  migration:" ? [index] : [],
  );
  assert.equal(starts.length, 1, "exactly one migration job is required");
  const first = starts[0];
  let last = first + 1;
  while (last < lines.length && !/^  [A-Za-z0-9_-]+:$/.test(lines[last]))
    last++;
  assert.equal(
    lines.slice(first, last).join("\n").trimEnd(),
    expected,
    "unconfigured migration must fail explicitly without starting a local DB",
  );
  // These known local-DB surfaces are forbidden across jobs. This is not a
  // generic shell parser: indirect scripts still require review. Non-DB
  // containers and read-only tool identity checks are not prohibited.
  for (const pattern of [
    /\b(?:docker\s+compose|docker-compose|podman\s+compose)\s+(?:up|start)\b[^\n]*\b(?:mysql|mariadb)\b/i,
    /\b(?:docker|podman)\s+(?:run|create)\b[^\n]*\b(?:mysql|mariadb)(?::|\s|$)/im,
    /^\s*image:\s*["']?(?:docker\.io\/library\/)?(?:mysql|mariadb)(?::|\s|["']|$)/im,
    /scripts\/test\/mysql-integration\.sh\b/i,
  ]) {
    assert.doesNotMatch(source, pattern, "known local MySQL startup surface");
  }
}

test("CTYun-only gate remains present and fail-closed", () =>
  verifyBoundary(workflow));
for (const [name, transform] of [
  ["false success", (s) => s.replace("          exit 1", "          exit 0")],
  ["missing exit", (s) => s.replace("          exit 1", "")],
  [
    "ignored failure",
    (s) =>
      s.replace(
        "  migration:\n",
        "  migration:\n    continue-on-error: true\n",
      ),
  ],
  [
    "skipped job",
    (s) => s.replace("  migration:\n", "  migration:\n    if: false\n"),
  ],
  [
    "local database startup",
    (s) =>
      s.replace(
        "    steps:\n",
        "    steps:\n      - run: docker compose up -d mysql\n",
      ),
  ],
  [
    "local service",
    (s) =>
      s.replace(
        "    steps:\n",
        "    services:\n      mysql:\n        image: mysql:8.4\n    steps:\n",
      ),
  ],
]) {
  test("reject " + name, () => {
    assert.throws(() => verifyBoundary(transform(expected)));
  });
}
test("removing or duplicating the migration job cannot pass", () => {
  assert.throws(() => verifyBoundary(""));
  assert.throws(() => verifyBoundary(expected + "\n" + expected));
});

test("a local DB moved into another job is rejected", () => {
  assert.throws(() =>
    verifyBoundary(
      workflow +
        "\n  hidden-db:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker compose up -d mysql\n",
    ),
  );
  assert.throws(() =>
    verifyBoundary(
      workflow +
        "\n  hidden-db:\n    services:\n      mysql:\n        image: mysql:8.4\n",
    ),
  );
});

test("non-DB container identity and Forge jobs remain permitted", () => {
  verifyBoundary(
    workflow +
      "\n  tool-identity:\n    steps:\n      - run: docker --version\n",
  );
  verifyBoundary(
    workflow +
      "\n  forge:\n    steps:\n      - run: docker run --rm --network none ghcr.io/foundry-rs/foundry:1.5.1 forge --version\n",
  );
});

test("known MySQL image and legacy local DB script in other jobs are rejected", () => {
  assert.throws(() =>
    verifyBoundary(
      workflow +
        "\n  db:\n    steps:\n      - run: docker run --rm mysql:8.4\n",
    ),
  );
  assert.throws(() =>
    verifyBoundary(
      workflow +
        "\n  db:\n    steps:\n      - run: bash scripts/test/mysql-integration.sh\n",
    ),
  );
});

test("bare Compose starts cannot start the root MySQL service", () => {
  for (const command of [
    "docker compose up -d",
    "docker compose up --wait",
    "docker compose start",
    "docker-compose up",
    "podman compose start",
  ]) {
    assert.throws(() =>
      verifyBoundary(
        workflow + `\n  other:\n    steps:\n      - run: ${command}\n`,
      ),
    );
  }
});

test("explicit redis with no database dependencies is allowed", () => {
  for (const command of [
    "docker compose up -d redis",
    "docker compose start redis",
    "docker compose up --wait redis",
  ]) {
    verifyBoundary(
      workflow + `\n  other:\n    steps:\n      - run: ${command}\n`,
    );
  }
});
