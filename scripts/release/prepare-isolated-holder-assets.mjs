import {
  prepareIsolatedHolderAssets,
  readIsolatedHolderBindingsFile,
} from "./lib/isolated-holder-assets.mjs";

const [directory, flag, file, ...extra] = process.argv.slice(2);
if (
  !directory ||
  extra.length ||
  (flag !== undefined && (flag !== "--bindings" || !file)) ||
  (flag === undefined && file !== undefined)
)
  throw Error(
    "usage: node scripts/release/prepare-isolated-holder-assets.mjs <private-input-directory> [--bindings <original-approved-bindings.json>]",
  );
try {
  const bindings = file
    ? await readIsolatedHolderBindingsFile(file)
    : undefined;
  const output = await prepareIsolatedHolderAssets(directory, bindings);
  process.stdout.write(JSON.stringify(output) + "\n");
} catch {
  process.stderr.write(
    "Isolated holder preparation failed; no publication, grant, delivery or transaction occurred.\n",
  );
  process.exitCode = 1;
}
