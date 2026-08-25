import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const webRequire = createRequire(join(repositoryRoot, "apps/web/package.json"));
const { privateKeyToAccount } = webRequire("viem/accounts");
const { verifyMessage } = webRequire("viem");

const keyPattern = /^0x[0-9a-fA-F]{64}$/;
const selfTestMessage = "ArtFi local test wallet ownership check v1";

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
}

function assertTestOnlyEnvironment(environment = process.env) {
  if (environment.ARTFI_ENV === "production") {
    throw new Error("local test wallet is disabled in production");
  }
  const chainId = environment.ARTFI_CHAIN_ID;
  if (chainId && chainId !== "560048") {
    throw new Error("local test wallet is restricted to Hoodi chain id 560048");
  }
}

function windowsPowerShell() {
  const pathVariable = process.env.Path || process.env.PATH || "";
  const modern = pathVariable
    .split(delimiter)
    .map((entry) => join(entry, "pwsh.exe"))
    .find((candidate) => existsSync(candidate));
  if (modern) return modern;

  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const legacy = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return existsSync(legacy) ? legacy : "pwsh";
}

export function assertPrivateKeyFilePermissions(
  keyPath,
  environment = process.env,
) {
  if (
    environment.NODE_ENV === "test" &&
    environment.ARTFI_TEST_WALLET_SKIP_PERMISSION_CHECK === "true"
  ) {
    return;
  }

  if (process.platform === "win32") {
    execFileSync(
      windowsPowerShell(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(scriptDirectory, "Test-ArtFiTestWalletAcl.ps1"),
        "-Path",
        keyPath,
        "-Quiet",
      ],
      { stdio: "ignore" },
    );
    return;
  }

  const metadata = statSync(keyPath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      "test private key file must not grant group or other permissions",
    );
  }
  if (
    typeof process.getuid === "function" &&
    metadata.uid !== process.getuid()
  ) {
    throw new Error("test private key file must be owned by the current user");
  }
}

export function resolvePrivateKeyFile(environment = process.env) {
  assertTestOnlyEnvironment(environment);
  const configured = environment.ARTFI_TEST_PRIVATE_KEY_FILE;
  if (!configured) throw new Error("ARTFI_TEST_PRIVATE_KEY_FILE is required");
  if (!isAbsolute(configured))
    throw new Error("ARTFI_TEST_PRIVATE_KEY_FILE must be an absolute path");

  const requested = resolve(configured);
  if (isInside(repositoryRoot, requested)) {
    throw new Error("test private key file must be outside the repository");
  }
  const linkMetadata = lstatSync(requested);
  if (linkMetadata.isSymbolicLink() || !linkMetadata.isFile()) {
    throw new Error(
      "test private key path must be a regular, non-symlinked file",
    );
  }

  const canonical = realpathSync(requested);
  if (isInside(repositoryRoot, canonical)) {
    throw new Error(
      "test private key file must resolve outside the repository",
    );
  }
  assertPrivateKeyFilePermissions(canonical, environment);
  return canonical;
}

export function loadTestAccount(environment = process.env) {
  const keyPath = resolvePrivateKeyFile(environment);
  const bytes = readFileSync(keyPath);
  try {
    if (bytes.byteLength > 68)
      throw new Error("test private key file has an invalid format");
    const privateKey = bytes.toString("utf8").trim();
    if (!keyPattern.test(privateKey)) {
      throw new Error("test private key file has an invalid format");
    }
    return privateKeyToAccount(privateKey);
  } finally {
    bytes.fill(0);
  }
}

export async function runSelfTest(environment = process.env) {
  const account = loadTestAccount(environment);
  const signature = await account.signMessage({ message: selfTestMessage });
  const verified = await verifyMessage({
    address: account.address,
    message: selfTestMessage,
    signature,
  });
  if (!verified)
    throw new Error("local test wallet signature verification failed");
  return { address: account.address, verified };
}

async function main() {
  const command = process.argv[2] || "self-test";
  if (command === "address") {
    process.stdout.write(`${loadTestAccount().address}\n`);
    return;
  }
  if (command === "self-test") {
    const result = await runSelfTest();
    process.stdout.write(
      `address=${result.address}\nverified=${result.verified}\n`,
    );
    return;
  }
  throw new Error("usage: test-wallet.mjs [address|self-test]");
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "local test wallet failed"}\n`,
    );
    process.exitCode = 1;
  });
}
