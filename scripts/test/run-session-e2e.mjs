import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = await mkdtemp(join(tmpdir(), "artfi-session-source-"));
const fixture = join(temporary, "public-source-fixture.json");
async function run(binary, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `Session validation command exited with ${code ?? signal}.`,
            ),
          ),
    );
  });
}
try {
  await run(
    process.env.GO_BINARY || "go",
    [
      "test",
      "./internal/httpapi",
      "-run",
      "^TestExportIsolatedRWACatalog$",
      "-count=1",
    ],
    join(root, "apps/api"),
    { ...process.env, ARTFI_EXPORT_RWA_FIXTURE: fixture },
  );
  await run(
    process.execPath,
    [
      join(root, "apps/web/node_modules/@playwright/test/cli.js"),
      "test",
      "--config=playwright.session.config.ts",
      ...process.argv.slice(2),
    ],
    join(root, "apps/web"),
    { ...process.env, ARTFI_E2E_SOURCE_FIXTURE: fixture },
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
