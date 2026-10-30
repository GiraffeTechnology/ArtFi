const fail = (code) => {
  throw Error(code);
};
const uint64 = (value) =>
  typeof value === "string" &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
const code = (value) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function actionHistoryPage(input = {}) {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !["after", "limit"].includes(key))
  )
    fail("AUDIT_PAGE_INVALID");
  const after = input.after === undefined ? "0" : input.after,
    limit = input.limit === undefined ? 100 : input.limit;
  if (
    !uint64(after) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    fail("AUDIT_PAGE_INVALID");
  return Object.freeze({ after, limit });
}
export function actionHistoryQuery(params) {
  if (
    !(params instanceof URLSearchParams) ||
    [...params.keys()].some(
      (key) =>
        !["after", "limit"].includes(key) || params.getAll(key).length !== 1,
    )
  )
    fail("AUDIT_PAGE_INVALID");
  const after = params.get("after") ?? "0",
    limit = params.get("limit") ?? "100";
  if (!/^[1-9][0-9]{0,2}$/.test(limit)) fail("AUDIT_PAGE_INVALID");
  return actionHistoryPage({ after, limit: Number(limit) });
}
function rowInteger(value, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!(
    (typeof value === "number" && Number.isSafeInteger(value)) ||
    uint64(value)
  ))
    fail("AUDIT_RECORD_INVALID");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    fail("AUDIT_RECORD_INVALID");
  return result;
}
export function decodeActionHistoryRows(
  rows,
  { operationId, mode, after, limit },
) {
  actionHistoryPage({ after, limit });
  if (
    !Array.isArray(rows) ||
    rows.length > limit ||
    typeof operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)
  )
    fail("AUDIT_RECORD_INVALID");
  let previous = BigInt(after);
  return rows.map((row) => {
    if (
      !object(row) ||
      !["string", "number", "bigint"].includes(typeof row.event_id) ||
      (typeof row.event_id === "number" && !Number.isSafeInteger(row.event_id))
    )
      fail("AUDIT_RECORD_INVALID");
    const id = String(row.event_id);
    if (
      !uint64(id) ||
      BigInt(id) <= previous ||
      row.operation_id !== operationId
    )
      fail("AUDIT_RECORD_INVALID");
    const version = rowInteger(row.operation_version, 1),
      observedAt = rowInteger(row.observed_at_ms, 0, 8640000000000000);
    let event;
    try {
      event =
        typeof row.event_json === "string"
          ? JSON.parse(row.event_json)
          : structuredClone(row.event_json);
    } catch {
      fail("AUDIT_RECORD_INVALID");
    }
    if (
      !object(event) ||
      event.mode !== mode ||
      !code(event.state) ||
      (event.reason !== undefined &&
        event.reason !== null &&
        !code(event.reason)) ||
      (event.action !== undefined && !code(event.action)) ||
      (event.leg !== undefined &&
        (typeof event.leg !== "string" ||
          !/^[A-Za-z0-9_.-]{1,128}$/.test(event.leg))) ||
      (event.reservedValue !== undefined &&
        (typeof event.reservedValue !== "string" ||
          !/^(0|[1-9][0-9]{0,77})$/.test(event.reservedValue) ||
          BigInt(event.reservedValue) >= 2n ** 256n)) ||
      (event.evidenceDigest !== undefined &&
        (typeof event.evidenceDigest !== "string" ||
          !/^[0-9a-f]{64}$/.test(event.evidenceDigest))) ||
      ["transactionHash", "orderHash"].some(
        (key) =>
          event[key] !== undefined &&
          (typeof event[key] !== "string" ||
            !/^0x[0-9a-fA-F]{64}$/.test(event[key])),
      )
    )
      fail("AUDIT_RECORD_INVALID");
    previous = BigInt(id);
    // SQL metadata wins over any JSON body. Unknown payload fields never leave history reads.
    return {
      id,
      operationId,
      version,
      observedAt,
      mode,
      state: event.state,
      ...Object.fromEntries(
        [
          "reason",
          "action",
          "leg",
          "reservedValue",
          "evidenceDigest",
          "transactionHash",
          "orderHash",
        ]
          .filter((key) => event[key] !== undefined)
          .map((key) => [key, event[key]]),
      ),
    };
  });
}
