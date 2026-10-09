import { MODE, readSecretFile, serviceURL, fail, LOOPBACK } from "./config.mjs";
import { readResponseJSON, exactInput } from "./http-json.mjs";

export const TEST_ADAPTER_CONTRACT = "ARTFI_ISOLATED_AGENT_ADAPTER_V1";
const methods = Object.freeze([
  "policy",
  "plan",
  "observe",
  "mint-authority",
  "execute",
  "verify",
  "reconcile",
  "revocation",
  "action-observe",
  "action-execute",
  "action-evidence",
  "native-plan",
  "action-opportunities",
]);
// This is an ArtFi-side integration-test protocol, not a claim about any wallet
// product. It is implemented by the fixed package and only permits loopback.
// No production protocol, source-authority implementation or signer is invented.
export async function createFixedAdapter(config, { fetchImpl = fetch } = {}) {
  if (config.kind === "unavailable") return null;
  if (config.kind !== "artfi-isolated-test-v1")
    fail("AGENT_ADAPTER_UNSUPPORTED");
  const base = serviceURL(config.baseURL);
  if (!LOOPBACK.has(new URL(base).hostname))
    fail("ISOLATED_TEST_ADAPTER_LOOPBACK_REQUIRED");
  const token = await readSecretFile(config.tokenFile);
  if (token.length < 32) fail("AGENT_ADAPTER_TOKEN_INVALID");
  async function call(method, input, signal) {
    if (!methods.includes(method)) fail("ADAPTER_METHOD_UNSUPPORTED");
    let response;
    try {
      response = await fetchImpl(`${base}/v1/artfi-agent-test/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-artfi-test-contract": TEST_ADAPTER_CONTRACT,
        },
        body: JSON.stringify({
          contract: TEST_ADAPTER_CONTRACT,
          mode: MODE,
          input,
        }),
        cache: "no-store",
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(4000)])
          : AbortSignal.timeout(4000),
      });
    } catch {
      fail("AGENT_ADAPTER_UNAVAILABLE");
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail("AGENT_ADAPTER_UNAVAILABLE");
    }
    const body = await readResponseJSON(response);
    if (
      !exactInput(body, ["contract", "mode", "isolated", "result"]) ||
      body.contract !== TEST_ADAPTER_CONTRACT ||
      body.mode !== MODE ||
      body.isolated !== true
    )
      fail("AGENT_ADAPTER_CONTRACT_MISMATCH");
    return body.result;
  }
  const policy = await call("policy", {});
  return Object.freeze({
    kind: config.kind,
    policy,
    actionPolicy: policy.actionPolicy ?? null,
    resolveNativePlan: (nativeOperationId, wallet) =>
      call("native-plan", { nativeOperationId, wallet }),
    readActionCandidates: (authority, signal) =>
      call("action-opportunities", { authority }, signal),
    actionObserve: (leg, record, signal) =>
      call("action-observe", { leg, record: publicRecord(record) }, signal),
    actionExecute: (leg, context, signal) =>
      call("action-execute", { leg, context }, signal),
    actionEvidence: (leg, record, signal) =>
      call("action-evidence", { leg, record: publicRecord(record) }, signal),
    planFor: (input, wallet) => call("plan", { input, wallet }),
    observe: (request, signal) => call("observe", { request }, signal),
    mintAuthority: (request, signal) =>
      call("mint-authority", { request }, signal),
    execute: (request, record, signal) =>
      call("execute", { request, record: publicRecord(record) }, signal),
    verify: (record, signal) =>
      call("verify", { record: publicRecord(record) }, signal),
    reconcile: (record, signal) =>
      call("reconcile", { record: publicRecord(record) }, signal),
    inspectRevocation: (request, transactionHash) =>
      call("revocation", { request, transactionHash }),
  });
}
function publicRecord(record) {
  const { leaseToken, leaseExpiresAt, ...rest } = record;
  return structuredClone(rest);
}
