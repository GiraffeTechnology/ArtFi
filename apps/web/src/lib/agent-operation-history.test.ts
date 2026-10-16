import { describe, expect, it, vi } from "vitest";
import {
  agentHistoryScopeKey,
  decodeAgentHistoryPage,
  fetchAgentHistoryPage,
  type AgentHistoryScope,
} from "./agent-operation-history";
const scope: AgentHistoryScope = {
  kind: "intents",
  id: "TEST_ONLY_op",
  mode: "TEST_ONLY_NO_REAL_VALUE",
  session: {
    id: "TEST_ONLY_session",
    address: "0x" + "a".repeat(40),
    chainId: 560048,
    expiresAt: 4000000000000,
    accessExpiresAt: 4000000000000,
  },
};
const event = (id = "1") => ({
  id,
  operationId: scope.id,
  state: "PREPARED",
  kind: "PREPARED",
  version: 1,
  observedAt: 1000,
});
const response = (events = [event()]) => ({
  id: scope.id,
  mode: scope.mode,
  events,
  nextAfter: events.at(-1)?.id ?? "0",
});
describe("session-scoped operation history paging", () => {
  it("preserves bigint cursors and uses the last returned event as the next cursor", () => {
    const value = decodeAgentHistoryPage(
      response([event("9007199254740993")]),
      scope,
      "9007199254740992",
    );
    expect(value.nextAfter).toBe("9007199254740993");
    expect(value.events[0].id).toBe("9007199254740993");
    expect(value.mayHaveMore).toBe(false);
  });
  it("only indicates a possible next page after a full batch", () => {
    const events = Array.from({ length: 100 }, (_, i) => event(String(i + 1)));
    expect(decodeAgentHistoryPage(response(events), scope).mayHaveMore).toBe(
      true,
    );
    expect(
      decodeAgentHistoryPage({ ...response([]), nextAfter: "99" }, scope, "99"),
    ).toMatchObject({ after: "99", nextAfter: "99", mayHaveMore: false });
  });
  it("rejects cross-operation, mode, duplicate, backwards and forged next cursors", () => {
    const values = [
      { ...response(), id: "other" },
      { ...response(), mode: "BOUNDED_SIGNED_AUTHORITY" },
      response([event(), event()]),
      response([event("2"), event("1")]),
      { ...response(), nextAfter: "2" },
      { ...response(), nextAfter: null },
      { ...response(), events: [{ ...event(), operationId: "other" }] },
      { ...response(), events: [{ ...event(), observedAt: -1 }] },
      { ...response(), events: [{ ...event(), version: 0 }] },
      { ...response(), events: [{ ...event(), reason: "TEST ONLY secret" }] },
    ];
    for (const value of values)
      expect(() => decodeAgentHistoryPage(value, scope)).toThrow();
    expect(() =>
      decodeAgentHistoryPage(response([event("1")]), scope, "1"),
    ).toThrow();
    expect(() =>
      decodeAgentHistoryPage(response(), scope, "18446744073709551616"),
    ).toThrow();
    expect(() => decodeAgentHistoryPage(response(), scope, "01")).toThrow();
  });
  it("whitelists event labels and omits raw payloads, credentials and unrecognized fields", () => {
    const value = decodeAgentHistoryPage(
      response([
        {
          ...event(),
          raw: "TEST_ONLY_PRIVATE",
          signature: "TEST_ONLY_PRIVATE",
        } as ReturnType<typeof event>,
      ]),
      scope,
    );
    expect(JSON.stringify(value)).not.toContain("TEST_ONLY_PRIVATE");
    expect(Object.keys(value.events[0]).sort()).toEqual([
      "id",
      "kind",
      "observedAt",
      "reason",
      "state",
      "version",
    ]);
  });
  it("strictly decodes workflow cursor metadata and whitelisted event fields", () => {
    const workflowScope: AgentHistoryScope = { ...scope, kind: "actions" };
    const workflowEvent = {
      id: "9007199254740993",
      operationId: workflowScope.id,
      mode: workflowScope.mode,
      version: 2,
      observedAt: 1000,
      state: "SUBMITTED",
      action: "BUY",
      leg: "native.submit",
      transactionHash: "0x" + "a".repeat(64),
      rawTransaction: "TEST_ONLY_PRIVATE",
    };
    const value = decodeAgentHistoryPage(
      {
        id: workflowScope.id,
        mode: workflowScope.mode,
        events: [workflowEvent],
        nextAfter: workflowEvent.id,
        page: { version: 1, after: "9007199254740992", limit: 100 },
      },
      workflowScope,
      "9007199254740992",
    );
    expect(value).toMatchObject({
      after: "9007199254740992",
      nextAfter: "9007199254740993",
      pagingAvailable: true,
      mayHaveMore: false,
      events: [{ id: "9007199254740993", action: "BUY", leg: "native.submit" }],
    });
    expect(JSON.stringify(value)).not.toContain("TEST_ONLY_PRIVATE");
  });
  it("rejects missing, mismatched or malformed workflow page contracts atomically", () => {
    const workflowScope: AgentHistoryScope = { ...scope, kind: "actions" };
    const valid = {
      id: workflowScope.id,
      mode: workflowScope.mode,
      events: [],
      nextAfter: "0",
      page: { version: 1, after: "0", limit: 100 },
    };
    for (const value of [
      { id: workflowScope.id, mode: workflowScope.mode, events: [] },
      { ...valid, page: { ...valid.page, version: 2 } },
      { ...valid, page: { ...valid.page, after: "1" } },
      { ...valid, page: { ...valid.page, limit: 99 } },
      { ...valid, nextAfter: "1" },
      {
        ...valid,
        events: [
          {
            id: "1",
            operationId: workflowScope.id,
            state: "PLANNED",
            observedAt: 1,
          },
        ],
      },
      {
        ...valid,
        events: [
          {
            id: "1",
            operationId: workflowScope.id,
            mode: workflowScope.mode,
            version: 1,
            state: "PLANNED",
            observedAt: 1,
            leg: "../private",
          },
        ],
      },
    ])
      expect(() => decodeAgentHistoryPage(value, workflowScope)).toThrow();
  });

  it("session identity, chain, wallet and both expiries are part of the private view scope", () => {
    for (const session of [
      { ...scope.session, id: "other-session" },
      { ...scope.session, address: "0x" + "b".repeat(40) },
      { ...scope.session, expiresAt: scope.session.expiresAt + 1 },
      { ...scope.session, accessExpiresAt: scope.session.accessExpiresAt + 1 },
    ])
      expect(agentHistoryScopeKey({ ...scope, session })).not.toBe(
        agentHistoryScopeKey(scope),
      );
    expect(() =>
      agentHistoryScopeKey({
        ...scope,
        session: { ...scope.session, chainId: 1 },
      }),
    ).toThrow();
    expect(() =>
      agentHistoryScopeKey({ ...scope, kind: "../other" }),
    ).toThrow();
  });
  it("requests exactly scoped GET pages with cookie authentication and no-store headers", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...response([event("101")]), nextAfter: "101" }),
    );
    const page = await fetchAgentHistoryPage(scope, "100", {
      fetchImpl: fetcher as typeof fetch,
    });
    expect(page.after).toBe("100");
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "/api/agent/intents/TEST_ONLY_op/history?after=100&limit=100",
    );
    expect(options.method).toBe("GET");
    expect(options.credentials).toBe("same-origin");
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    expect(options.headers).toMatchObject({
      "x-artfi-wallet": scope.session.address,
      "x-artfi-chain": "560048",
    });
  });
  it("requests workflow history with the canonical cursor query", async () => {
    const workflowScope: AgentHistoryScope = { ...scope, kind: "actions" };
    const fetcher = vi.fn(async () =>
      Response.json({
        id: scope.id,
        mode: scope.mode,
        events: [],
        nextAfter: "9007199254740993",
        page: { version: 1, after: "9007199254740993", limit: 100 },
      }),
    );
    await fetchAgentHistoryPage(workflowScope, "9007199254740993", {
      fetchImpl: fetcher as typeof fetch,
    });
    const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(
      "/api/agent/actions/TEST_ONLY_op/history?after=9007199254740993&limit=100",
    );
  });
  it("rejects expired access or already aborted reads without making a request", async () => {
    const fetcher = vi.fn();
    await expect(
      fetchAgentHistoryPage(
        { ...scope, session: { ...scope.session, accessExpiresAt: 1 } },
        "0",
        { fetchImpl: fetcher },
      ),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchAgentHistoryPage(scope, "0", {
        signal: controller.signal,
        fetchImpl: fetcher,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects HTTP refusals, invalid UTF-8 and oversized bodies with bounded generic errors", async () => {
    const bodies = [
      new Response("TEST_ONLY_PRIVATE", { status: 403 }),
      new Response(new Uint8Array([0xff]), {
        headers: { "content-type": "application/json" },
      }),
      new Response(" ".repeat(131073), {
        headers: { "content-type": "application/json" },
      }),
      new Response("TEST_ONLY_PRIVATE", {
        headers: { "content-type": "text/plain" },
      }),
    ];
    for (const body of bodies) {
      await expect(
        fetchAgentHistoryPage(scope, "0", {
          fetchImpl: (async () => body) as typeof fetch,
        }),
      ).rejects.toThrow(
        "Agent history is unavailable or could not be verified.",
      );
    }
  });
});
