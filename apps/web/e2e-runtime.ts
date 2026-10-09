import { resolve } from "node:path";

// Test-only launcher for the same immutable native bundle installed by operators.
// Keep fixture configuration at runtime so one build can exercise every suite.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function webRuntime(
  sourceCommand: string,
  hostname: string,
  port: number | string,
  env: Record<string, string> = {},
) {
  const bundleRoot = process.env.ARTFI_E2E_BUNDLE_ROOT;
  if (!bundleRoot) return { command: sourceCommand, env };
  return {
    command: `${shellQuote(resolve(bundleRoot, "runtime/bin/node"))} ${shellQuote(resolve(bundleRoot, "runtime/web/apps/web/server.js"))}`,
    env: { ...env, HOSTNAME: hostname, PORT: String(port) },
  };
}

export function apiRuntimeCommand(sourceCommand: string): string {
  const bundleRoot = process.env.ARTFI_E2E_BUNDLE_ROOT;
  return bundleRoot
    ? shellQuote(resolve(bundleRoot, "runtime/bin/artfi-api"))
    : sourceCommand;
}
