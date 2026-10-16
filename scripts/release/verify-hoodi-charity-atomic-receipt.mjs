import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { verifyHoodiCharityAtomicReceipt } from "./lib/hoodi-charity-atomic-receipt.mjs";
const { JsonRpcProvider, FetchRequest } = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
)("ethers");

const [manifestPath, option, envName, ...extra] = process.argv.slice(2);
if (
  !manifestPath ||
  option !== "--rpc-env" ||
  !/^[A-Z][A-Z0-9_]*$/.test(envName ?? "") ||
  extra.length
) {
  throw new Error(
    "usage: node scripts/release/verify-hoodi-charity-atomic-receipt.mjs <private-manifest.json> --rpc-env <existing-variable-name>",
  );
}
let provider;
try {
  const url = new URL(process.env[envName] ?? "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" &&
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
  )
    throw new Error("unsupported transport");
  const transport = new FetchRequest(url.toString());
  transport.timeout = 15000;
  transport.allowInsecureAuthentication = false;
  provider = new JsonRpcProvider(transport, undefined, {
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const output = await verifyHoodiCharityAtomicReceipt(
    manifest,
    (method, params) => provider.send(method, params),
  );
  process.stdout.write(JSON.stringify(output) + "\n");
} catch {
  // Ethers errors may include the credential-bearing transport URL. Keep them out of logs.
  process.stderr.write(
    "Hoodi atomic receipt verification failed; no transaction was sent and no acceptance is claimed.\n",
  );
  process.exitCode = 1;
} finally {
  if (provider) await provider.destroy();
}
