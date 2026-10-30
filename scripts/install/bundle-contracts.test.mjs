import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { bundleContracts } from "./bundle-contracts.mjs";
const { keccak256 } = createRequire(
  new URL("../../apps/agent-runtime/package.json", import.meta.url),
)("ethers");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "artfi-contract-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/agent-runtime"), { recursive: true });
  await symlink(
    resolve("apps/agent-runtime/node_modules"),
    join(root, "apps/agent-runtime/node_modules"),
    "dir",
  );
  await mkdir(join(root, "packages/contracts/src"), { recursive: true });
  for (const name of [
    "RWARegistry",
    "ArtFiMarket",
    "WholeArtworkMarket",
    "ArtFiAdminSafe",
  ]) {
    const source = `src/${name}.sol`,
      body = `// TEST_ONLY artifact-export fixture\ncontract ${name} {}`;
    await writeFile(join(root, "packages/contracts", source), body);
    await mkdir(join(root, "packages/contracts/out", name + ".sol"), {
      recursive: true,
    });
    await writeFile(
      join(root, "packages/contracts/out", name + ".sol", name + ".json"),
      JSON.stringify({
        abi: [{ type: "constructor", inputs: [] }],
        bytecode: { object: "0x6000", linkReferences: {} },
        metadata: {
          compiler: { version: "0.8.30+commit.73712a01" },
          settings: { compilationTarget: { [source]: name } },
          sources: { [source]: { keccak256: keccak256(Buffer.from(body)) } },
        },
      }),
    );
  }
  return root;
}
test("exports pinned source-matching application ABI/bytecode without selecting deployments", async (t) => {
  const root = await fixture(t),
    out = join(root, "export");
  const result = await bundleContracts(root, out, "fixture-source");
  assert.equal(result.length, 4);
  assert.ok(result.every((x) => x.deployable));
  assert.equal(
    JSON.parse(await readFile(join(out, "inventory.json"))).sourceFingerprint,
    "fixture-source",
  );
});
test("stale compiler artifact cannot silently replace changed source", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "packages/contracts/src/RWARegistry.sol"),
    "// source changed",
  );
  await assert.rejects(
    bundleContracts(root, join(root, "export"), "fixture-source"),
    /does not match/,
  );
});
test("missing required application artifacts fail the package build", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "packages/contracts/out/ArtFiMarket.sol"), {
    recursive: true,
  });
  await assert.rejects(
    bundleContracts(root, join(root, "export"), "fixture-source"),
    /artifacts are missing/,
  );
});
