import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTaskListingRuntime,
  packTaskListingRuntime,
} from "./build-task-listing-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const config = {
  schema: "artfi-server-listing-config/1",
  chainId: "1",
  executionZone: "sin",
  tradingEnabled: true,
  sdkTimeoutMs: 12000,
  collections: [
    {
      slug: "test-only",
      chain: "ethereum",
      contract: `0x${"1".repeat(40)}`,
      standard: "erc721",
      label: "TEST_ONLY",
      charity: false,
    },
  ],
  rpc: { url: "http://127.0.0.1:1", sourceId: "TEST_ONLY", timeoutMs: 100 },
  observation: {
    policyId: "TEST_ONLY",
    allowedDeployments: [
      {
        chainId: "1",
        address: "0x0000000000000068F116a894984e2DB1123eB395",
        runtimeCodeHash: `0x${"2".repeat(64)}`,
        proxyOrUpgradeAllowed: false,
        reviewEvidenceSha256: "3".repeat(64),
      },
    ],
    scanPolicy: {
      fromBlock: 1,
      throughBlock: 2,
      blocksPerPage: 1,
      maxPagesPerRun: 1,
      maxLogsPerPage: 1,
      maxCandidatesPerRun: 1,
    },
  },
};
function probe(directory, code = "", conditions = true, credentials = false) {
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (/^(?:NODE_PATH|NODE_OPTIONS|ARTFI_|OPENSEA_|NEXT_PUBLIC_)/.test(name))
      delete env[name];
  if (credentials) env.OPENSEA_API_KEY = "TEST_ONLY_NOT_A_LIVE_KEY";
  return spawnSync(
    process.execPath,
    [
      ...(conditions ? ["--conditions=react-server"] : []),
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict'; const runtime = await import('./server.mjs'); ${code}`,
    ],
    { cwd: directory, env, encoding: "utf8", timeout: 20000 },
  );
}
function succeeded(result) {
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("real installed listing runtime closure and strict configuration", async (t) => {
  const temporary = await mkdtemp(
    join(tmpdir(), "artfi-installed-task-runtime-"),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const built = await buildTaskListingRuntime({
    root,
    destination: join(temporary, "runtime"),
  });
  const archive = join(temporary, "artfi-task-listing-runtime-1.0.0.tgz");
  await packTaskListingRuntime({ directory: built.destination, archive });
  const consumer = join(temporary, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "test-only-runtime-consumer",
      private: true,
      dependencies: { "@artfi/task-listing-runtime": `file:${archive}` },
    }),
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  for (const args of [["install", "--package-lock-only"], ["ci"]]) {
    const result = spawnSync(
      "npm",
      [
        ...args,
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(temporary, "npm-cache"),
      ],
      {
        cwd: consumer,
        env,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    succeeded(result);
  }
  const destination = join(
    consumer,
    "node_modules/@artfi/task-listing-runtime",
  );
  await t.test(
    "exact interface imports actual native, journal, terms and observer with no source loader",
    () => {
      succeeded(
        probe(
          destination,
          `
      assert.equal(runtime.runtimeManifest.walletInterface, '8415-task-listing-runtime/1');
      for (const name of ['createNativeNftTaskPort','createNftTaskJournal','nftTaskJournalDigest',
        'createNftSaleTermsVerifier','createListedOrderObserver','validateServerListingConfig',
        'createServerListingDependencies','readNftRequest','kernelRequestDigest']) assert.equal(typeof runtime[name], 'function', name);
      assert.equal(typeof runtime.ethers.TypedDataEncoder.hash, 'function');
      assert.equal(typeof runtime.validation.validateTypedData, 'function');
      assert.throws(() => runtime.createNativeNftTaskPort({}), /configur|verif|function|required/i);
    `,
        ),
      );
    },
  );
  await t.test(
    "true server-only default refuses import instead of using a stub",
    () => {
      const result = probe(destination, "", false);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /cannot be imported from a Client Component/);
    },
  );
  await t.test(
    "all manifest files and marker bytes match and no external links or lifecycle scripts remain",
    async () => {
      assert.deepEqual(built.manifest.links, {});
      assert.ok(
        Object.keys(built.manifest.files).every(
          (path) => !path.split("/").some((part) => part.startsWith(".")),
        ),
      );
      assert.deepEqual(
        built.manifest.normalization.find((entry) => entry.name === "treeify")
          .removedMetadataFiles,
        [
          {
            path: ".travis.yml",
            originalSha256:
              "54338079b530a045421714fd68523a2881e2d068e9ba43c4f06ec9fb10f0b652",
            reason: "OBSOLETE_UPSTREAM_CI_METADATA",
          },
        ],
      );
      for (const [path, digest] of Object.entries(built.manifest.files))
        assert.equal(
          sha(await readFile(join(destination, path))),
          digest,
          path,
        );
      for (const [path, digest] of Object.entries(
        built.manifest.dependencies["server-only"].sourceFiles,
      ))
        assert.equal(
          sha(
            await readFile(join(destination, "node_modules/server-only", path)),
          ),
          digest,
        );
      for (const entry of built.manifest.normalization) {
        const pkg = JSON.parse(
          await readFile(join(destination, entry.path), "utf8"),
        );
        for (const key of ["preinstall", "install", "postinstall", "prepare"])
          assert.equal(pkg.scripts?.[key], undefined, entry.path);
        assert.equal(
          sha(await readFile(join(destination, entry.path))),
          entry.normalizedSha256,
        );
      }
    },
  );
  await t.test(
    "fixed JSON factory rejects missing secret, injected code, ambiguous pins and unsafe bounds",
    () => {
      succeeded(
        probe(
          destination,
          `
      const config = ${JSON.stringify(config)};
      const valid = runtime.validateServerListingConfig(config);
      assert.ok(Object.isFrozen(valid.observation.scanPolicy));
      assert.throws(() => runtime.createServerListingDependencies(config, {journal: async () => {}}), /OPENSEA_UNCONFIGURED/);
      for (const mutate of [
        c => c.module = '/tmp/caller-code.mjs', c => c.factory = () => {},
        c => c.collections[0].chain = 'base', c => c.rpc.url = 'http://remote.invalid',
        c => c.rpc.url = 'https://user:password@example.invalid', c => c.rpc.url = 'https://example.invalid?key=hidden',
        c => c.observation.allowedDeployments = [], c => c.observation.allowedDeployments[0].proxyOrUpgradeAllowed = true,
        c => c.observation.scanPolicy.maxPagesPerRun = 101, c => c.observation.scanPolicy.throughBlock = 0,
        c => c.observation.seaportABI = [], c => c.sdkTimeoutMs = 60000,
      ]) { const changed = structuredClone(config); mutate(changed); assert.throws(() => runtime.validateServerListingConfig(changed)); }
      let getterCalled = false;
      const malicious = {...config}; Object.defineProperty(malicious, 'module', {enumerable:true,get(){getterCalled=true;return 'bad';}});
      assert.throws(() => runtime.validateServerListingConfig(malicious)); assert.equal(getterCalled, false);
      let serializerCalled = false;
      class MaliciousArray extends Array { toJSON() { serializerCalled = true; return [config.collections[0]]; } }
      assert.throws(() => runtime.validateServerListingConfig({...config,collections:new MaliciousArray(config.collections[0])}));
      assert.equal(serializerCalled, false);
      const extra = structuredClone(config); extra.collections.module = '/tmp/untrusted.mjs';
      assert.throws(() => runtime.validateServerListingConfig(extra));
      const sparse = structuredClone(config); delete sparse.collections[0];
      assert.throws(() => runtime.validateServerListingConfig(sparse));
      const accessor = structuredClone(config); Object.defineProperty(accessor.collections, '0', {enumerable:true,get(){getterCalled=true;return config.collections[0];}});
      assert.throws(() => runtime.validateServerListingConfig(accessor)); assert.equal(getterCalled, false);
    `,
        ),
      );
    },
  );
  await t.test(
    "factory provides official SDK/read-only transport without authority or arbitrary RPC",
    () => {
      succeeded(
        probe(
          destination,
          `
      const config = ${JSON.stringify(config)};
      const journal = async () => {};
      const created = runtime.createServerListingDependencies(config, {journal});
      assert.equal(created.nativeDependencies.journal, journal);
      assert.equal(created.nativeDependencies.verifyTaskBinding, undefined);
      assert.equal(created.nativeDependencies.withTaskAuthorization, undefined);
      assert.equal(created.canonicalReader, created.observationDependencies.readOnlyProvider);
      assert.equal(created.canonicalReader.sourceId, 'TEST_ONLY');
      const scope = created.nativeDependencies.scope('test-only');
      created.nativeDependencies.requireTrading();
      assert.throws(() => created.nativeDependencies.scope('unknown'));
      assert.throws(() => created.nativeDependencies.provider({...scope, contract:'0x'+'9'.repeat(40)}));
      await assert.rejects(created.canonicalReader.request({method:'eth_sendRawTransaction',params:[]}));
      await assert.rejects(created.nativeDependencies.provider(scope).send('eth_sendTransaction',[]));
      const disabled = runtime.createServerListingDependencies({...config,tradingEnabled:false},{journal});
      assert.throws(() => disabled.nativeDependencies.requireTrading(), /TRADING_DISABLED/);
      created.nativeDependencies.provider(scope).destroy(); disabled.nativeDependencies.provider(scope).destroy();
    `,
          true,
          true,
        ),
      );
    },
  );
  for (const missing of [
    "dist/apps/web/src/lib/nft/task-port.js",
    "dist/apps/web/src/lib/nft/task-journal.js",
    "dist/scripts/agent/nft-sale-terms.mjs",
    "dist/scripts/agent/listed-order-observer.mjs",
    "node_modules/ethers",
    "node_modules/server-only",
    "node_modules/@opensea/sdk",
  ]) {
    await t.test(
      `missing ${missing} is a genuine installed import failure`,
      async () => {
        const file = join(destination, missing),
          hidden = `${file}.test-hidden`;
        await rename(file, hidden);
        try {
          const result = probe(destination);
          assert.notEqual(result.status, 0);
          assert.match(result.stderr, /MODULE_NOT_FOUND|Cannot find/);
        } finally {
          await rename(hidden, file);
        }
        succeeded(probe(destination));
      },
    );
  }
  await t.test(
    "existing destination is neither overwritten nor deleted",
    async () => {
      await assert.rejects(
        buildTaskListingRuntime({ root, destination }),
        /EEXIST/,
      );
      assert.ok((await readdir(destination)).includes("server.mjs"));
    },
  );
});
