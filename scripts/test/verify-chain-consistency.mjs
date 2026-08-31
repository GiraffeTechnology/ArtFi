#!/usr/bin/env node
// Asserts that every live layer naming the test chain names the same one.
//
// This check exists because of a real failure. On 2026-08-24 the client directed
// that testing move to Hoodi and authorized test assets. The shell tooling was
// migrated and required chain id 560048; the four Foundry deploy scripts were
// not, and still reverted on anything but Ethereum Sepolia. The tooling
// contradicted itself, deployment to Hoodi was impossible whatever credentials
// were supplied, and nothing surfaced the contradiction — no test covered the
// agreement between layers, so the directive simply could not be executed and
// that fact stayed invisible for days.
//
// Release artifacts are deliberately excluded. `release/` and the published
// metadata under `apps/web/public/nft/metadata` record a mint that actually
// happened on Ethereum Sepolia; their hashes are bound on chain and
// `ACCEPTANCE.md` §3 rules out rewriting them. Their verifiers stay pinned to
// 11155111 by design.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The one place the expected chain is written down. */
const CHAIN = { name: "Hoodi", id: 560048, underscored: "560_048" };

/** Chains that must not appear in live tooling, whatever the notation. */
const SUPERSEDED = [
  { name: "Ethereum Sepolia", patterns: [/\b11155111\b/, /\b11_155_111\b/] },
  { name: "Base Sepolia", patterns: [/\b84532\b/, /\b84_532\b/] },
];

const read = (relative) => readFile(join(repoRoot, relative), "utf8");

/**
 * Strips comments so the superseded-chain scan reads executable code only.
 * A comment explaining that the chain moved *from* Ethereum Sepolia is
 * legitimate history; a constant still holding that value is the defect.
 */
function executableOnly(source, file) {
  if (/\.(sql)$/.test(file)) return source.replace(/--[^\n]*/g, "");
  if (/\.(sh|ps1)$/.test(file)) return source.replace(/(^|\s)#[^\n]*/g, "$1");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Each entry names a layer, the file that layer lives in, and a pattern proving
 * that file agrees with CHAIN. A layer missing from this list is a layer that
 * can drift silently, so add one whenever a new surface learns the chain id.
 */
const LAYERS = [
  // Solidity — the layer that was missed.
  ...[
    "DeployStage2",
    "DeployStage3",
    "DeployStage4",
    "DeployAdminSafe",
    "DeployCharityEditions",
  ].map((script) => ({
    layer: `solidity/${script}`,
    file: `packages/contracts/script/${script}.s.sol`,
    expect: new RegExp(`HOODI_CHAIN_ID\\s*=\\s*${CHAIN.underscored}\\s*;`),
    why: "deploy script must accept the configured test chain",
  })),

  // Shell tooling.
  ...[
    "sepolia-preflight.sh",
    "sepolia-standards-probe.sh",
    "sepolia-charity-editions-probe.sh",
  ].map((script) => ({
    layer: `shell/${script}`,
    file: `scripts/test/${script}`,
    expect: new RegExp(`"${CHAIN.id}"`),
    why: "preflight and probes must guard on the configured test chain",
  })),

  // TypeScript runtime.
  {
    layer: "web/wagmi",
    file: "apps/web/src/lib/wagmi.ts",
    expect: /supportedChain\s*=\s*hoodi\b/,
    why: "wallet writes must target the configured test chain",
  },
  {
    layer: "web/wagmi.test",
    file: "apps/web/src/lib/wagmi.test.ts",
    expect: new RegExp(`toBe\\(${CHAIN.id}\\)`),
    why: "the chain assertion must pin the configured test chain",
  },
  {
    layer: "web/health",
    file: "apps/web/src/app/api/health/route.ts",
    expect: new RegExp(`chainId:\\s*${CHAIN.id}\\b`),
    why: "the health route reports the chain to operators",
  },

  // Go runtime.
  {
    layer: "api/chain-constant",
    file: "apps/api/internal/httpapi/rwa.go",
    expect: new RegExp(`hoodiChainID\\s*=\\s*${CHAIN.id}\\b`),
    why: "the API chain constant is written into every intent",
  },

  // Schema.
  {
    layer: "sql/chain-constraints",
    file: "apps/api/migrations/000008_hoodi_test_chain.up.sql",
    expect: new RegExp(`chain_id\\s*=\\s*${CHAIN.id}\\b`),
    why: "CHECK constraints reject rows written on any other chain",
  },

  // Local signer and configuration.
  {
    layer: "scripts/test-wallet",
    file: "scripts/local/test-wallet.mjs",
    expect: new RegExp(`"${CHAIN.id}"`),
    why: "the offline signer restricts itself to the configured test chain",
  },
  {
    layer: "config/env-example",
    file: ".env.example",
    expect: new RegExp(`^ARTFI_CHAIN_ID=${CHAIN.id}$`, "m"),
    why: "a developer copying the example must land on the configured chain",
  },
  {
    layer: "config/dockerfile-rpc",
    file: "apps/web/Dockerfile",
    expect: /NEXT_PUBLIC_HOODI_RPC_URL/,
    why: "Next.js substitutes public variables at build time; a stale name ships a client that ignores the operator's RPC",
  },
];

/** Live tooling that must not mention a superseded chain at all. */
const NO_SUPERSEDED = [
  ...LAYERS.map((entry) => entry.file),
  "apps/web/src/lib/operator-auth.ts",
  "apps/api/internal/httpapi/handler.go",
  "scripts/local/New-ArtFiTestWallet.ps1",
];

const failures = [];

for (const { layer, file, expect, why } of LAYERS) {
  let source;
  try {
    source = await read(file);
  } catch {
    failures.push(`${layer}: ${file} is missing — the layer cannot be checked`);
    continue;
  }
  if (!expect.test(source)) {
    failures.push(
      `${layer}: ${file} does not name ${CHAIN.name} ${CHAIN.id} — ${why}`,
    );
  }
}

for (const file of new Set(NO_SUPERSEDED)) {
  let source;
  try {
    source = await read(file);
  } catch {
    continue;
  }
  const code = executableOnly(source, file);
  for (const { name, patterns } of SUPERSEDED) {
    for (const pattern of patterns) {
      if (pattern.test(code)) {
        failures.push(
          `${file} still names ${name} (${pattern.source}); live tooling must name only ${CHAIN.name} ${CHAIN.id}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `chain consistency failed — layers disagree about the test chain:\n\n` +
      failures.map((line) => `  - ${line}\n`).join("") +
      `\nEvery layer above must name ${CHAIN.name} ${CHAIN.id}. A directive the\n` +
      `tooling silently refuses to execute is the failure this check prevents\n` +
      `(ACCEPTANCE.md §7.16).\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `chain-consistency=pass (${LAYERS.length} layers agree on ${CHAIN.name} ${CHAIN.id})\n`,
);
