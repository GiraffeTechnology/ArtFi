import {
  constants,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  lstatSync,
} from "node:fs";
import { createRequire } from "node:module";
import { verifyHoodiVaultFractions } from "./lib/hoodi-vault-fraction-receipts.mjs";
const { JsonRpcProvider, FetchRequest } = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
)("ethers");
const [file, flag, envName, ...extra] = process.argv.slice(2);
let provider;
try {
  if (file === undefined) {
    process.stdout.write(
      JSON.stringify(await verifyHoodiVaultFractions()) + "\n",
    );
    process.exitCode = 2;
  } else {
    if (
      flag !== "--rpc-env" ||
      !/^[A-Z][A-Z0-9_]*$/.test(envName ?? "") ||
      extra.length
    )
      throw Error("ARGUMENTS");
    if (lstatSync(file).isSymbolicLink()) throw Error("INPUT_SYMLINK");
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let raw;
    try {
      const a = fstatSync(fd);
      if (!a.isFile() || a.size < 1 || a.size > 65536)
        throw Error("INPUT_SIZE");
      raw = readFileSync(fd);
      const b = fstatSync(fd);
      if (
        raw.length !== a.size ||
        b.size !== a.size ||
        b.mtimeMs !== a.mtimeMs ||
        b.ctimeMs !== a.ctimeMs
      )
        throw Error("INPUT_CHANGED");
    } finally {
      closeSync(fd);
    }
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    );
    const url = new URL(process.env[envName] ?? "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" &&
        !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    )
      throw Error("TRANSPORT");
    const transport = new FetchRequest(url.toString());
    transport.timeout = 15000;
    transport.allowInsecureAuthentication = false;
    provider = new JsonRpcProvider(transport, undefined, {
      batchMaxCount: 1,
      cacheTimeout: -1,
    });
    const result = await verifyHoodiVaultFractions(manifest, (method, params) =>
      provider.send(method, params),
    );
    process.stdout.write(JSON.stringify(result) + "\n");
  }
} catch {
  // Underlying provider errors can contain endpoint credentials; never print them.
  process.stderr.write(
    "Vault/fraction verification did not establish the required evidence; no transaction was sent.\n",
  );
  process.exitCode = 1;
} finally {
  if (provider) await provider.destroy();
}
