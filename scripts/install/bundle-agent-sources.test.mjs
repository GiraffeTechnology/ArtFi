import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { bundleAgentSources } from "./bundle-agent-sources.mjs";
const root =
  process.env.ARTFI_RUNTIME_SOURCE_ROOT ??
  fileURLToPath(new URL("../../", import.meta.url));
assert.equal(process.platform, "linux");
const temporary = await mkdtemp(join(tmpdir(), "artfi-agent-source-layout-"));
test("native Agent bundle loads the current compiled NFT graph with its exact shared currency source", async () => {
  const destination = join(temporary, "closed");
  await mkdir(destination);
  await bundleAgentSources(root, destination);
  const script = pathToFileURL(
    join(destination, "scripts/agent/stage1-action-plans.mjs"),
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const m=await import(" +
        JSON.stringify(script) +
        ");if(typeof m.compileStage1Action!=='function')throw Error('Missing compiler');",
    ],
    { cwd: destination, env: process.env, encoding: "utf8", timeout: 20000 },
  );
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const source = await readFile(join(root, "scripts/native-nft-currency.mjs"));
  const packaged = await readFile(
    join(destination, "scripts/native-nft-currency.mjs"),
  );
  assert.equal(
    createHash("sha256").update(packaged).digest("hex"),
    createHash("sha256").update(source).digest("hex"),
  );
});
test("Agent source copying refuses an existing runtime tree and preserves its files", async () => {
  const destination = join(temporary, "preserved");
  await mkdir(join(destination, "scripts/agent"), { recursive: true });
  const sentinel = join(destination, "scripts/agent/operator-file");
  await writeFile(sentinel, "preserve");
  await assert.rejects(bundleAgentSources(root, destination), /EEXIST/);
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
});
