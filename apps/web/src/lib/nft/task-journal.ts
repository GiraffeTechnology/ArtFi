import "server-only";
import { createHash } from "node:crypto";
import { boundedOrderText } from "../native-order-upstream";
import { NftError, type NftTaskPrincipal } from "./model";
import type { NftOperation } from "./journal";

export const NFT_TASK_JOURNAL_PATH = "/internal/v1/nft/operations";
export const NFT_TASK_JOURNAL_INTERFACE = "artfi-task-journal/1";
export type NftTaskJournalAction = "get" | "create" | "update";
export type NftTaskJournalOperation = Partial<NftOperation> & { id: string };
export type NftTaskJournalCapabilityScope = {
  principal: NftTaskPrincipal;
  action: NftTaskJournalAction;
  nativeOperationId: string;
  planDigest: string;
  requestDigest: string;
  operation: NftTaskJournalOperation;
};
export type NftTaskJournalConfig = {
  /** Fixed internal HTTPS endpoint; never taken from a browser request. */
  url: string;
  /** Expected exact URI SAN of the installed outbound mTLS workload identity. */
  peerId: string;
  /** Server-owned, mutually authenticated HTTPS transport. A global fetch or
   * Authorization bridge bearer alone cannot implement this interface. */
  transport(url: string, init: RequestInit): Promise<Response>;
  /** Enter/reuse the real grant gate, mint one action/request-bound capability,
   * and hold that SAME gate until use settles. A capability is neither a new
   * grant nor a substitute for grant verification. Its consume endpoint must
   * use the held-capability registry without reacquiring the grant store lock. */
  withCapability<T>(
    scope: NftTaskJournalCapabilityScope & { peerId: string },
    use: (capability: string) => Promise<T>,
  ): Promise<T>;
};
const principalKeys = [
  "kind",
  "taskId",
  "taskDigest",
  "executorDigest",
  "grantReference",
  "grantPolicyVersion",
  "operationId",
].sort();
const forbidden = new Set([
  "signature",
  "exactsignature",
  "privatekey",
  "seedphrase",
  "mnemonic",
  "rawtransaction",
  "signedtransaction",
  "rawsignedtransaction",
  "signedrawtransaction",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "authorization",
  "capability",
  "password",
  "secret",
]);
const statuses = new Set([
  "awaiting-wallet",
  "submitted",
  "pending",
  "accepted",
  "cancelled",
  "rejected",
  "failed",
  "confirmed",
]);
function unavailable(
  message = "The authenticated task journal is unavailable.",
): never {
  throw new NftError(503, message);
}
function unsigned(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(unsigned);
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, child]) =>
        !forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) &&
        !key
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .includes("signature") &&
        unsigned(child),
    );
  return true;
}
function checkPrincipal(value: NftTaskPrincipal) {
  if (
    !value ||
    Object.keys(value).sort().join() !== principalKeys.join() ||
    value.kind !== "task" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.taskId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.operationId) ||
    !/^0x[0-9a-f]{64}$/.test(value.taskDigest) ||
    !/^0x[0-9a-f]{64}$/.test(value.executorDigest) ||
    !/^grant:[A-Za-z0-9_-]{1,122}$/.test(value.grantReference) ||
    !/^[1-9][0-9]{0,77}$/.test(value.grantPolicyVersion)
  )
    throw new NftError(403, "Invalid task journal principal.");
}
/** Exact Go wire-digest contract, not the existing native plan review digest.
 * ASCII property names and safe integer numbers keep Go/JS canonicalization
 * identical. Strings may contain arbitrary Unicode, including HTML characters. */
export function nftTaskJournalDigest(value: unknown): string {
  const canonical = (x: unknown): string => {
    if (x === null || typeof x === "string" || typeof x === "boolean")
      return JSON.stringify(x);
    if (typeof x === "number" && Number.isSafeInteger(x))
      return JSON.stringify(x);
    if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
    if (x && Object.getPrototypeOf(x) === Object.prototype) {
      return `{${Object.keys(x)
        .sort()
        .map((key) => {
          if ([...key].some((character) => character.charCodeAt(0) > 127))
            unavailable("Invalid task journal encoding.");
          return `${JSON.stringify(key)}:${canonical((x as Record<string, unknown>)[key])}`;
        })
        .join(",")}}`;
    }
    unavailable("Invalid task journal encoding.");
  };
  const encoded = canonical(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return createHash("sha256").update(encoded).digest("hex");
}
function checkResult(
  result: NftOperation,
  principal: NftTaskPrincipal,
  action: NftTaskJournalAction,
  operation: NftTaskJournalOperation,
  planDigest: string,
) {
  if (
    !result ||
    result.id !== operation.id ||
    !result.plan ||
    !/^0x[0-9a-fA-F]{40}$/.test(result.wallet) ||
    !Number.isSafeInteger(result.chainId) ||
    result.chainId <= 0 ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1 ||
    !statuses.has(result.status) ||
    !/^[0-9a-f]{64}$/.test(result.requestHash) ||
    typeof result.walletStarted !== "boolean" ||
    typeof result.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(result.updatedAt)) ||
    result.plan.operationId !== result.id ||
    result.plan.chainId !== result.chainId ||
    "sessionId" in result.plan ||
    !unsigned(result) ||
    !result.plan.taskPrincipal ||
    nftTaskJournalDigest(result.plan.taskPrincipal) !==
      nftTaskJournalDigest(principal) ||
    !result.plan.request ||
    result.plan.request.account.toLowerCase() !== result.wallet.toLowerCase() ||
    (result.orderHash !== undefined &&
      !/^0x[0-9a-fA-F]{64}$/.test(result.orderHash)) ||
    (result.transactionHash !== undefined &&
      !/^0x[0-9a-fA-F]{64}$/.test(result.transactionHash))
  )
    unavailable("The task journal returned an invalid or foreign operation.");
  if (
    action !== "get" &&
    (nftTaskJournalDigest(result.plan) !== planDigest ||
      result.requestHash !== operation.requestHash ||
      result.wallet.toLowerCase() !== operation.wallet?.toLowerCase() ||
      result.chainId !== operation.chainId ||
      (action === "update" &&
        result.revision !== Number(operation.revision) + 1))
  )
    unavailable("The task journal returned a changed operation.");
  return structuredClone(result);
}

/** Fixed composition factory; no environment-based bridge/session fallback. */
export function createNftTaskJournal(config?: NftTaskJournalConfig) {
  const url = (() => {
    try {
      return new URL(config?.url ?? "");
    } catch {
      return undefined;
    }
  })();
  const configured = Boolean(
    config &&
    url?.protocol === "https:" &&
    url.pathname === NFT_TASK_JOURNAL_PATH &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    config.peerId &&
    typeof config.transport === "function" &&
    typeof config.withCapability === "function",
  );
  const transport = config?.transport;
  const withCapability = config?.withCapability;
  const peerId = config?.peerId;
  const endpoint = url?.href;
  return async function journal(
    rawPrincipal: NftTaskPrincipal,
    action: NftTaskJournalAction,
    rawOperation: NftTaskJournalOperation,
  ): Promise<NftOperation> {
    if (!configured || !transport || !withCapability || !endpoint || !peerId)
      unavailable();
    const principal = structuredClone(rawPrincipal);
    checkPrincipal(principal);
    // Round-trip exactly the JSON that crosses the boundary (undefined optional
    // properties are omitted). The snapshot cannot change during any await.
    const operation = JSON.parse(
      JSON.stringify(rawOperation),
    ) as NftTaskJournalOperation;
    if (
      !["get", "create", "update"].includes(action) ||
      !/^[A-Za-z0-9_-]{16,80}$/.test(operation.id) ||
      !unsigned(operation)
    )
      throw new NftError(422, "Invalid unsigned task journal operation.");
    if (
      action !== "get" &&
      (!operation.plan ||
        "sessionId" in operation.plan ||
        nftTaskJournalDigest(operation.plan.taskPrincipal) !==
          nftTaskJournalDigest(principal))
    )
      throw new NftError(
        403,
        "The operation does not match its task principal.",
      );
    const body = JSON.stringify({ action, operation });
    if (Buffer.byteLength(body) > 65536)
      throw new NftError(413, "The task record is too large.");
    const planDigest =
      action === "get" ? "" : nftTaskJournalDigest(operation.plan);
    const scope = {
      principal,
      action,
      operation,
      peerId,
      nativeOperationId: operation.id,
      planDigest,
      requestDigest: nftTaskJournalDigest({ action, operation }),
    };
    let entered = false;
    try {
      const result = await withCapability(
        structuredClone(scope),
        async (capability) => {
          if (entered)
            throw new NftError(409, "The journal capability was already used.");
          entered = true;
          if (
            typeof capability !== "string" ||
            capability.length < 32 ||
            capability.length > 2048 ||
            /\s/.test(capability)
          )
            throw new NftError(403, "Invalid task journal capability.");
          const response = await transport(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${capability}`,
            },
            body,
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new NftError(
              [400, 401, 403, 404, 409, 413, 422].includes(response.status)
                ? response.status
                : 503,
              "The task operation could not be verified. Read its durable state before retrying.",
            );
          }
          return checkResult(
            JSON.parse(await boundedOrderText(response.body, 65536)),
            principal,
            action,
            operation,
            planDigest,
          );
        },
      );
      if (!entered) unavailable();
      return checkResult(result, principal, action, operation, planDigest);
    } catch (error) {
      if (error instanceof NftError) throw error;
      // Never retry a write here. Lost responses may follow a committed CAS.
      unavailable(
        "The task journal outcome is unknown. Read its durable state before retrying.",
      );
    }
  };
}
