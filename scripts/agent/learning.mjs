// Non-authority optimization only. A learned value is never a policy value.
// Inputs are bounded outcome telemetry, not intent/Oracle/source-trust updates.
const fail = (code) => {
  throw Error(code);
};
const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 1000000000;
export function recordOptimization(previous, input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "action",
          "providerId",
          "outcome",
          "durationMs",
          "gasUsed",
          "reason",
          "observedAt",
        ].includes(k),
    ) ||
    !id(input.action) ||
    !id(input.providerId) ||
    !["SUCCESS", "FAILURE", "INCIDENT"].includes(input.outcome) ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0 ||
    (input.durationMs !== undefined &&
      (!count(input.durationMs) || input.durationMs > 86400000)) ||
    (input.gasUsed !== undefined && !count(input.gasUsed)) ||
    (input.reason !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.reason))
  )
    fail("OPTIMIZATION_SAMPLE_INVALID");
  const state = previous
    ? structuredClone(previous)
    : {
        schemaVersion: 1,
        authority: "ADVISORY_ONLY",
        providers: {},
        actions: {},
        incidents: {},
        samples: 0,
      };
  if (
    state.schemaVersion !== 1 ||
    state.authority !== "ADVISORY_ONLY" ||
    !count(state.samples) ||
    !state.providers ||
    !state.actions ||
    !state.incidents
  )
    fail("OPTIMIZATION_STATE_INVALID");
  for (const records of [state.providers, state.actions])
    if (Object.keys(records).length > 32) fail("OPTIMIZATION_STATE_INVALID");
  if (Object.keys(state.incidents).length > 64)
    fail("OPTIMIZATION_STATE_INVALID");
  const bump = (value = 0) => Math.min(1000000000, value + 1);
  function track(records, key) {
    if (!records[key] && Object.keys(records).length >= 32) return;
    const row = records[key] ?? {
      successes: 0,
      failures: 0,
      latencyMs: null,
      gasEstimate: null,
    };
    if (!count(row.successes) || !count(row.failures))
      fail("OPTIMIZATION_STATE_INVALID");
    if (input.outcome === "SUCCESS") row.successes = bump(row.successes);
    if (input.outcome === "FAILURE") row.failures = bump(row.failures);
    if (input.durationMs !== undefined)
      row.latencyMs =
        row.latencyMs === null
          ? input.durationMs
          : Math.round((row.latencyMs * 7 + input.durationMs) / 8);
    if (input.gasUsed !== undefined)
      row.gasEstimate =
        row.gasEstimate === null
          ? input.gasUsed
          : Math.round((row.gasEstimate * 7 + input.gasUsed) / 8);
    records[key] = row;
  }
  track(state.providers, input.providerId);
  track(state.actions, input.action);
  if (
    input.reason &&
    (Object.hasOwn(state.incidents, input.reason) ||
      Object.keys(state.incidents).length < 64)
  )
    state.incidents[input.reason] = bump(state.incidents[input.reason]);
  state.samples = bump(state.samples);
  state.observedAt = input.observedAt;
  return state;
}
export function optimizationHints(
  state,
  { approvedProviders, minimumDelayMs = 100, maximumDelayMs = 10000 },
) {
  if (
    !Array.isArray(approvedProviders) ||
    approvedProviders.length > 32 ||
    approvedProviders.some((x) => !id(x)) ||
    new Set(approvedProviders).size !== approvedProviders.length ||
    !Number.isSafeInteger(minimumDelayMs) ||
    !Number.isSafeInteger(maximumDelayMs) ||
    minimumDelayMs < 10 ||
    maximumDelayMs < minimumDelayMs ||
    maximumDelayMs > 60000
  )
    fail("OPTIMIZATION_SCOPE_INVALID");
  const providers = approvedProviders.map((id, index) => {
    const stats = state?.providers?.[id];
    const total = (stats?.successes ?? 0) + (stats?.failures ?? 0);
    return {
      id,
      index,
      score: total ? (stats.successes + 1) / (total + 2) : 0.5,
      latency: stats?.latencyMs ?? minimumDelayMs,
    };
  });
  providers.sort(
    (a, b) => b.score - a.score || a.latency - b.latency || a.index - b.index,
  );
  return Object.freeze({
    authority: "ADVISORY_ONLY",
    providerOrder: providers.map((x) => x.id),
    recommendedDelayMs: Math.min(
      maximumDelayMs,
      Math.max(minimumDelayMs, providers[0]?.latency ?? minimumDelayMs),
    ),
    policyChangesAllowed: false,
  });
}
