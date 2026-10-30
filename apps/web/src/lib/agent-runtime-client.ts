import type { UserSession } from "@/lib/user-session-client-state";
export const agentMode = "TEST_ONLY_NO_REAL_VALUE";
export type AgentMode = typeof agentMode | "BOUNDED_SIGNED_AUTHORITY";
const validMode = (mode: unknown) =>
  mode === agentMode || mode === "BOUNDED_SIGNED_AUTHORITY";
export type AgentRuntimeStatus = {
  schemaVersion: 1;
  mode: AgentMode;
  productionReady: false;
  state: "SAFE_DEGRADED" | "TEST_ONLY_READY";
  adapterKind: "unavailable" | "artfi-isolated-test-v1";
  walletProtocol: "NOT_CONFIRMED";
  capabilities: Record<
    | "prepareIntent"
    | "createIntent"
    | "queryIntent"
    | "recordRevocation"
    | "history"
    | "signIntent"
    | "revokeNonce",
    boolean
  > & { actionWorkflows?: boolean; queryActions?: boolean };
  actions: {
    action: string;
    available: boolean;
    reason?: string;
    testOnly?: boolean;
  }[];
  constitutionalMutations: false;
  privateKeyCustody: false;
  limitations: string[];
  observedAt: number;
  reason?: string | null;
};
export type AgentOperation = {
  id: string;
  mode: typeof agentMode;
  intent: {
    wallet: string;
    nonce: string;
    maxUnitPrice: string;
    maxAggregateExposure: string;
    validUntil: string;
  };
  asset: { chainId: string; contract: string; tokenId: string };
  fresh: boolean;
  observedAt: number;
  execution: { state: string; canonical: boolean; transactionHash?: string };
  grounding: { state: string };
  reconciliation: { state: string; accountingMatches: boolean };
  recovery: { state: string };
  revocation: { state: string };
};
export type AgentHistory = {
  id: string;
  mode: typeof agentMode;
  events: {
    id: string;
    kind: string;
    state: string;
    reason?: string;
    observedAt: number;
    version: number;
  }[];
  nextAfter: string;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function validAgentRuntimeStatus(
  value: unknown,
): value is AgentRuntimeStatus {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !validMode(value.mode) ||
    value.productionReady !== false ||
    !["SAFE_DEGRADED", "TEST_ONLY_READY"].includes(String(value.state)) ||
    !["unavailable", "artfi-isolated-test-v1"].includes(
      String(value.adapterKind),
    ) ||
    value.walletProtocol !== "NOT_CONFIRMED" ||
    value.constitutionalMutations !== false ||
    value.privateKeyCustody !== false ||
    !Number.isSafeInteger(value.observedAt) ||
    !object(value.capabilities) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.limitations)
  )
    return false;
  const caps = value.capabilities;
  return (
    [
      "prepareIntent",
      "createIntent",
      "queryIntent",
      "recordRevocation",
      "history",
      "signIntent",
      "revokeNonce",
    ].every((key) => typeof caps[key] === "boolean") &&
    caps.signIntent === false &&
    caps.revokeNonce === false &&
    value.actions.length <= 32 &&
    value.actions.every(
      (action) =>
        object(action) &&
        typeof action.action === "string" &&
        /^[A-Z_]{1,40}$/.test(action.action) &&
        typeof action.available === "boolean",
    ) &&
    value.limitations.every(
      (item) => typeof item === "string" && item.length <= 512,
    )
  );
}
export function validAgentOperation(
  value: unknown,
  id: string,
  session: UserSession,
): value is AgentOperation {
  if (
    !object(value) ||
    value.id !== id ||
    value.mode !== agentMode ||
    !object(value.intent) ||
    !object(value.asset) ||
    !object(value.execution) ||
    !object(value.grounding) ||
    !object(value.reconciliation) ||
    !object(value.recovery) ||
    !object(value.revocation) ||
    typeof value.fresh !== "boolean" ||
    !Number.isSafeInteger(value.observedAt)
  )
    return false;
  return (
    typeof value.intent.wallet === "string" &&
    value.intent.wallet.toLowerCase() === session.address.toLowerCase() &&
    value.asset.chainId === "560048" &&
    /^0x[0-9a-fA-F]{40}$/.test(String(value.asset.contract)) &&
    /^(0|[1-9][0-9]*)$/.test(String(value.asset.tokenId)) &&
    [
      "PREPARED",
      "STARTED",
      "SUBMITTED",
      "CONFIRMED",
      "UNKNOWN",
      "RECONCILING",
      "SAFE_DEGRADED",
      "SETTLED",
      "TERMINAL_REJECTED",
    ].includes(String(value.execution.state)) &&
    typeof value.execution.canonical === "boolean" &&
    typeof value.reconciliation.accountingMatches === "boolean" &&
    (value.execution.state !== "SETTLED" ||
      (value.execution.canonical === true &&
        value.reconciliation.state === "MATCHED" &&
        value.reconciliation.accountingMatches === true))
  );
}
export class AgentRequestError extends Error {
  constructor(public status: number) {
    super(
      status === 401 || status === 403
        ? "Sign in again with this wallet."
        : status === 404
          ? "This operation was not found for this wallet."
          : "Agent runtime is unavailable. No execution or revocation was confirmed.",
    );
  }
}
export async function agentRequest(
  path: string,
  session: UserSession,
  options: { body?: unknown; signal?: AbortSignal } = {},
) {
  if (
    !/^(status|(?:intents|actions)(?:\/prepare|\/[A-Za-z0-9_-]{1,128}(?:\/(?:history|revocations))?)?)$/.test(
      path,
    )
  )
    throw new AgentRequestError(400);
  const response = await fetch(`/api/agent/${path}`, {
    method: options.body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "x-artfi-wallet": session.address,
      "x-artfi-chain": String(session.chainId),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AgentRequestError(response.status);
  }
  const text = await response.text();
  if (text.length > 131_072) throw new AgentRequestError(503);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentRequestError(503);
  }
}

export type AgentWorkflow = {
  id: string;
  mode: AgentMode;
  supportLevel: "ISOLATED_APP_SIDE_CONTRACT" | "CONFIGURED_APP_SIDE_CONTRACT";
  state: string;
  action: string;
  marketKind: string;
  wallet: string;
  chainId: string;
  asset: { contract: string; tokenId: string };
  cursor: number;
  steps: {
    name: string;
    state: string;
    evidence?: {
      kind: string;
      verified: boolean;
      transactionHash?: string;
      orderKey?: string;
    };
  }[];
  recoveryAttempts: number;
  reason: string | null;
  observedAt: number;
  limits: {
    maxExecutions: string;
    maxOpenOrders: string;
    maxAggregateExposure: string;
    validUntil: string;
  };
};
export function validAgentWorkflow(
  value: unknown,
  id: string,
  session: UserSession,
): value is AgentWorkflow {
  return (
    object(value) &&
    value.id === id &&
    validMode(value.mode) &&
    value.supportLevel ===
      (value.mode === agentMode
        ? "ISOLATED_APP_SIDE_CONTRACT"
        : "CONFIGURED_APP_SIDE_CONTRACT") &&
    value.chainId === String(session.chainId) &&
    typeof value.wallet === "string" &&
    value.wallet.toLowerCase() === session.address.toLowerCase() &&
    object(value.asset) &&
    object(value.limits) &&
    /^0x[0-9a-fA-F]{40}$/.test(String(value.asset.contract)) &&
    /^(0|[1-9][0-9]*)$/.test(String(value.asset.tokenId)) &&
    [
      "PLANNED",
      "STARTED",
      "UNKNOWN",
      "RECONCILING",
      "SAFE_DEGRADED",
      "COMPLETED",
      "REJECTED",
      "FAILED_FINAL",
    ].includes(String(value.state)) &&
    Array.isArray(value.steps) &&
    value.steps.length >= 1 &&
    value.steps.length <= 2 &&
    Number.isSafeInteger(value.cursor) &&
    Number(value.cursor) >= 0 &&
    Number(value.cursor) <= value.steps.length &&
    value.steps.every(
      (step) =>
        object(step) &&
        typeof step.name === "string" &&
        typeof step.state === "string" &&
        (step.state !== "COMPLETED" ||
          (object(step.evidence) && step.evidence.verified === true)),
    ) &&
    (value.state !== "COMPLETED" ||
      value.steps.every(
        (step) => object(step) && step.state === "COMPLETED",
      )) &&
    Number.isSafeInteger(value.observedAt)
  );
}

export const ownerConfirmedMarkets = [
  {
    kind: "NFT",
    href: "/nft",
    label: "Native NFT review and wallet confirmation",
  },
  {
    kind: "WHOLE",
    href: "/market/rwa",
    label: "Whole-artwork market and wallet confirmation",
  },
  {
    kind: "FRACTION",
    href: "/market/fractionals",
    label: "Fractional order book and wallet confirmation",
  },
  {
    kind: "AUCTION",
    href: "/market/auctions",
    label: "Auctions, settlement and credit withdrawal",
  },
  {
    kind: "OFFERING",
    href: "/projects",
    label: "Project offering claims and refunds",
  },
] as const;
export function ownerConfirmedMarket(kind: string) {
  return ownerConfirmedMarkets.find((market) => market.kind === kind);
}
