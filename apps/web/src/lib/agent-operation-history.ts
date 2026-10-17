import type { UserSession } from "./user-session-client-state";
import { agentMode, type AgentMode } from "./agent-runtime-client";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const cursor = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const label = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
export type AgentHistoryScope = {
  kind: string;
  id: string;
  mode: AgentMode;
  session: UserSession;
};
export type AgentHistoryRow = {
  id: string;
  state: string;
  kind: string | null;
  reason: string | null;
  observedAt: number;
  version: number | null;
  action: string | null;
  leg: string | null;
};
export type AgentHistoryPage = {
  scopeKey: string;
  after: string;
  nextAfter: string;
  pagingAvailable: boolean;
  mayHaveMore: boolean;
  events: AgentHistoryRow[];
};
export function agentHistoryScopeKey(scope: AgentHistoryScope) {
  const s = scope.session;
  if (
    !["intents", "actions"].includes(scope.kind) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope.id) ||
    ![agentMode, "BOUNDED_SIGNED_AUTHORITY"].includes(scope.mode) ||
    !s ||
    typeof s.id !== "string" ||
    !s.id ||
    s.id.length > 256 ||
    !/^0x[0-9a-fA-F]{40}$/.test(s.address) ||
    !Number.isSafeInteger(s.chainId) ||
    (scope.kind === "intents" && s.chainId !== 560048) ||
    !Number.isSafeInteger(s.expiresAt) ||
    s.expiresAt <= 0 ||
    !Number.isSafeInteger(s.accessExpiresAt) ||
    s.accessExpiresAt <= 0
  )
    throw Error("Agent history scope is invalid.");
  return JSON.stringify([
    scope.kind,
    scope.id,
    scope.mode,
    s.id,
    s.address.toLowerCase(),
    s.chainId,
    s.expiresAt,
    s.accessExpiresAt,
  ]);
}
export function decodeAgentHistoryPage(
  value: unknown,
  scope: AgentHistoryScope,
  after = "0",
  limit = 100,
): AgentHistoryPage {
  const scopeKey = agentHistoryScopeKey(scope);
  if (
    !cursor(after) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !object(value) ||
    value.id !== scope.id ||
    value.mode !== scope.mode ||
    !Array.isArray(value.events) ||
    value.events.length > limit
  )
    throw Error("Agent history response is invalid.");

  const pagingAvailable = value.nextAfter !== undefined;
  if (scope.kind === "actions") {
    const page = value.page;
    if (
      !pagingAvailable ||
      !cursor(value.nextAfter) ||
      !object(page) ||
      Object.keys(page).sort().join(",") !== "after,limit,version" ||
      page.version !== 1 ||
      page.after !== after ||
      page.limit !== limit
    )
      throw Error("Workflow history page metadata is invalid.");
  } else if (!pagingAvailable || !cursor(value.nextAfter)) {
    throw Error("Agent history cursor is unavailable or invalid.");
  }

  let previous = BigInt(after);
  const events = value.events.map((item): AgentHistoryRow => {
    const isAction = scope.kind === "actions";
    if (
      !object(item) ||
      !cursor(item.id) ||
      BigInt(item.id) <= previous ||
      !label(item.state) ||
      !Number.isSafeInteger(item.observedAt) ||
      Number(item.observedAt) < 0 ||
      Number(item.observedAt) > 8640000000000000 ||
      (item.operationId !== undefined && item.operationId !== scope.id) ||
      (isAction &&
        (item.operationId !== scope.id ||
          item.mode !== scope.mode ||
          !Number.isSafeInteger(item.version) ||
          Number(item.version) < 1)) ||
      (!isAction &&
        (item.operationId !== scope.id ||
          !label(item.kind) ||
          !Number.isSafeInteger(item.version) ||
          Number(item.version) < 1)) ||
      (item.kind !== undefined && !label(item.kind)) ||
      (item.action !== undefined && !label(item.action)) ||
      (item.leg !== undefined &&
        (typeof item.leg !== "string" ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(item.leg))) ||
      (item.version !== undefined &&
        (!Number.isSafeInteger(item.version) || Number(item.version) < 1)) ||
      (item.reason !== undefined && item.reason !== null && !label(item.reason))
    )
      throw Error("Agent history event is invalid.");
    previous = BigInt(item.id);
    return {
      id: item.id,
      state: item.state,
      kind: typeof item.kind === "string" ? item.kind : null,
      reason: typeof item.reason === "string" ? item.reason : null,
      observedAt: Number(item.observedAt),
      version: typeof item.version === "number" ? item.version : null,
      action: typeof item.action === "string" ? item.action : null,
      leg: typeof item.leg === "string" ? item.leg : null,
    };
  });
  const nextAfter = events.at(-1)?.id ?? after;
  if (value.nextAfter !== nextAfter)
    throw Error("Agent history cursor does not match the returned page.");
  return {
    scopeKey,
    after,
    nextAfter,
    pagingAvailable: true,
    mayHaveMore: events.length === limit,
    events,
  };
}
export async function fetchAgentHistoryPage(
  scope: AgentHistoryScope,
  after = "0",
  {
    signal,
    fetchImpl = fetch,
  }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
) {
  agentHistoryScopeKey(scope);
  if (
    !cursor(after) ||
    scope.session.expiresAt <= Date.now() ||
    scope.session.accessExpiresAt <= Date.now()
  )
    throw Error("The wallet session expired. Sign in again.");
  const query = new URLSearchParams({ after, limit: "100" });
  const suffix = "?" + query;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 12000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(
      `/api/agent/${scope.kind}/${encodeURIComponent(scope.id)}/history${suffix}`,
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          "x-artfi-wallet": scope.session.address,
          "x-artfi-chain": String(scope.session.chainId),
        },
        signal: controller.signal,
      },
    );
    if (
      !response.ok ||
      response.redirected ||
      !/^application\/json(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    ) {
      await response.body?.cancel();
      throw Error();
    }
    reader = response.body?.getReader();
    if (!reader) throw Error();
    let length = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (;;) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 131072) throw Error();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    controller.signal.throwIfAborted();
    if (
      scope.session.expiresAt <= Date.now() ||
      scope.session.accessExpiresAt <= Date.now()
    )
      throw Error();
    return decodeAgentHistoryPage(JSON.parse(text), scope, after, 100);
  } catch {
    throw Error(
      "Agent history is unavailable or could not be verified. Sign in again if your session changed.",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    try {
      await reader?.cancel();
    } catch {
      /* No transport exception is exposed. */
    }
  }
}
