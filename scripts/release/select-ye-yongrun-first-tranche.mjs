import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectFirstCharityTranche } from "./charity-first-tranche.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--batch-directory" || args[1].length === 0) {
  process.stderr.write("Usage: node scripts/release/select-ye-yongrun-first-tranche.mjs --batch-directory <existing-batch-directory>\n");
  process.exitCode = 1;
} else {
  try {
    const batchDirectory = resolve(repositoryRoot, args[1]);
    const result = selectFirstCharityTranche({
      indexBytes: readFileSync(join(batchDirectory, "package-index.json")),
      readPackage: (filename) => readFileSync(join(batchDirectory, "packages", filename)),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // Do not disclose filesystem locations or package content on failure.
    process.stderr.write("First charity tranche selection failed. Check the original batch index and package bytes.\n");
    process.exitCode = 1;
  }
}
