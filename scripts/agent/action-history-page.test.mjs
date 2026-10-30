import test from "node:test";
import assert from "node:assert/strict";
import {
  actionHistoryPage,
  actionHistoryQuery,
  decodeActionHistoryRows,
} from "./action-history-page.mjs";
const mode = "TEST_ONLY_NO_REAL_VALUE",
  operationId = "TEST_ONLY_history";
const row = (id = "1", event = {}) => ({
  event_id: id,
  operation_id: operationId,
  operation_version: "2",
  observed_at_ms: "1000",
  event_json: JSON.stringify({ mode, state: "PLANNED", ...event }),
});
const decode = (rows, page = {}) =>
  decodeActionHistoryRows(rows, {
    operationId,
    mode,
    ...actionHistoryPage(page),
  });
test("canonical uint64 cursors remain exact above the JavaScript integer boundary", () => {
  assert.deepEqual(actionHistoryPage(), { after: "0", limit: 100 });
  const page = actionHistoryQuery(
    new URLSearchParams("after=18446744073709551614&limit=1"),
  );
  assert.deepEqual(page, { after: "18446744073709551614", limit: 1 });
  assert.equal(
    decode([row(18446744073709551615n)], page)[0].id,
    "18446744073709551615",
  );
  assert.equal(Object.isFrozen(page), true);
});
test("unknown, duplicate, overflow and noncanonical page inputs are refused", () => {
  for (const query of [
    "after=01",
    "after=-1",
    "after=1e3",
    "after=18446744073709551616",
    "after=1&after=2",
    "limit=1&limit=1",
    "limit=0",
    "limit=101",
    "limit=01",
    "limit=1.0",
    "cursor=1",
  ]) {
    assert.throws(
      () => actionHistoryQuery(new URLSearchParams(query)),
      /AUDIT_PAGE_INVALID/,
      query,
    );
  }
  for (const page of [
    null,
    [],
    { after: 1 },
    { after: "" },
    { after: null },
    { limit: null },
    { limit: "2" },
    { limit: 1.5 },
    { after: "0", wallet: "other" },
  ]) {
    assert.throws(() => actionHistoryPage(page), /AUDIT_PAGE_INVALID/);
  }
});
test("SQL metadata is authoritative and unknown private payload fields are omitted", () => {
  const result = decode([
    row("3", {
      id: "999",
      operationId: "OTHER",
      version: 99,
      observedAt: 999,
      state: "SUBMITTED",
      leg: "native.submit",
      transactionHash: "0x" + "a".repeat(64),
      rawTransaction: "PRIVATE_RAW_SENTINEL",
      signature: "PRIVATE_SIGNATURE_SENTINEL",
      envelope: { wallet: "PRIVATE_ENVELOPE_SENTINEL" },
    }),
  ])[0];
  assert.deepEqual(result, {
    id: "3",
    operationId,
    version: 2,
    observedAt: 1000,
    mode,
    state: "SUBMITTED",
    leg: "native.submit",
    transactionHash: "0x" + "a".repeat(64),
  });
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});
test("duplicate, backwards, cross-operation and oversized batches fail atomically", () => {
  for (const rows of [
    [row("2"), row("2")],
    [row("3"), row("2")],
    [{ ...row(), operation_id: "OTHER" }],
    [row(Number.MAX_SAFE_INTEGER + 1)],
    [row("18446744073709551616")],
    [row(["1"])],
    [row({ toString: () => "1" })],
  ])
    assert.throws(() => decode(rows), /AUDIT_RECORD_INVALID/);
  assert.throws(
    () => decode([row("2")], { after: "2" }),
    /AUDIT_RECORD_INVALID/,
  );
  assert.throws(
    () => decode([row("1"), row("2")], { limit: 1 }),
    /AUDIT_RECORD_INVALID/,
  );
});
test("invalid database metadata, mode and malformed event fields cannot become history", () => {
  for (const bad of [
    { operation_version: "0" },
    { observed_at_ms: "8640000000000001" },
    { event_json: "{" },
    { event_json: "[]" },
    { event_json: "null" },
    { event_json: JSON.stringify({ mode: "OTHER", state: "PLANNED" }) },
  ])
    assert.throws(() => decode([{ ...row(), ...bad }]), /AUDIT_RECORD_INVALID/);
  for (const event of [
    { state: "<script>" },
    { reason: "private free text" },
    { action: null },
    { leg: "../private/path" },
    { reservedValue: (1n << 256n).toString() },
    { evidenceDigest: 1 },
    { evidenceDigest: "0x" + "a".repeat(64) },
    { transactionHash: "bad" },
    { orderHash: null },
  ])
    assert.throws(() => decode([row("1", event)]), /AUDIT_RECORD_INVALID/);
});
test("all current workflow event projections preserve their bounded public fields", () => {
  const events = [
    { state: "PLANNED", action: "BUY" },
    { state: "STARTED", action: "SELL", leg: "sell", reservedValue: "0" },
    {
      state: "COMPLETED",
      action: "CANCEL",
      leg: "cancel",
      evidenceDigest: "f".repeat(64),
      transactionHash: "0x" + "b".repeat(64),
    },
    { state: "SUBMITTED", leg: "order", orderHash: "0x" + "c".repeat(64) },
    {
      state: "SAFE_DEGRADED",
      reason: "DEPENDENCY_UNAVAILABLE",
      leg: "COMPLETE",
    },
    { state: "REJECTED", reason: null },
  ];
  const result = decode(events.map((event, i) => row(String(i + 1), event)));
  assert.deepEqual(
    result.map(
      ({
        id,
        operationId: ignored,
        version,
        observedAt,
        mode: ignoredMode,
        ...event
      }) => event,
    ),
    events,
  );
  assert.deepEqual(decode([], { after: "100" }), []);
});
