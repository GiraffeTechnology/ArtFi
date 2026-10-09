// Attributed observation normalization. A timestamp or an adapter boolean does
// not extend a source's approved scope. Failed reads preserve last-known data.
export const OBSERVATION_STATES = Object.freeze([
  "CURRENT",
  "STALE",
  "UNAVAILABLE",
  "CONFLICTING",
  "UNVERIFIED",
]);
const fail = (code) => {
  throw Error(code);
};
const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
export function normalizeObservation(source, input, now = Date.now()) {
  if (
    !source ||
    !id(source.id) ||
    !Array.isArray(source.scopes) ||
    source.scopes.length === 0 ||
    source.scopes.some((x) => !id(x)) ||
    !Number.isSafeInteger(source.maxAgeMs) ||
    source.maxAgeMs < 1 ||
    source.maxAgeMs > 86400000 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    fail("OBSERVATION_SOURCE_INVALID");
  const base = { sourceId: source.id, receivedAt: now };
  if (
    !input ||
    input.sourceId !== source.id ||
    !source.scopes.includes(input.scope) ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0 ||
    input.observedAt > now + 5000 ||
    !OBSERVATION_STATES.includes(input.status) ||
    !id(input.revision)
  )
    return { ...base, status: "UNVERIFIED", reason: "OBSERVATION_INVALID" };
  let status = input.status;
  if (status === "CURRENT" && now - input.observedAt > source.maxAgeMs)
    status = "STALE";
  return Object.freeze({
    ...base,
    scope: input.scope,
    revision: input.revision,
    observedAt: input.observedAt,
    status,
    ...(Object.hasOwn(input, "data")
      ? { data: structuredClone(input.data) }
      : {}),
  });
}

export function createObservationReader({
  sources,
  timeoutMs = 3000,
  clock = Date.now,
}) {
  if (
    !Array.isArray(sources) ||
    sources.length === 0 ||
    sources.length > 32 ||
    new Set(sources.map((x) => x.id)).size !== sources.length ||
    sources.some((x) => typeof x.read !== "function") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000 ||
    typeof clock !== "function"
  )
    fail("OBSERVATION_READER_INVALID");
  const fixed = sources.map((source) => ({
    definition: structuredClone({
      id: source.id,
      scopes: source.scopes,
      maxAgeMs: source.maxAgeMs,
    }),
    read: source.read.bind(source),
  }));
  for (const source of fixed)
    normalizeObservation(source.definition, null, clock());
  const lastKnown = new Map();
  return Object.freeze({
    async read(request, signal) {
      return Promise.all(
        fixed.map(async (source) => {
          const controller = new AbortController();
          let timer;
          const abort = () => controller.abort();
          signal?.addEventListener("abort", abort, { once: true });
          try {
            if (signal?.aborted) throw Error("OBSERVATION_ABORTED");
            const input = await Promise.race([
              source.read(structuredClone(request), controller.signal),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(Error("OBSERVATION_TIMEOUT"));
                }, timeoutMs);
              }),
            ]);
            const observation = normalizeObservation(
              source.definition,
              input,
              clock(),
            );
            if (observation.status === "CURRENT")
              lastKnown.set(source.definition.id, structuredClone(observation));
            return observation;
          } catch {
            return Object.freeze({
              sourceId: source.definition.id,
              receivedAt: clock(),
              status: "UNAVAILABLE",
              reason: "SOURCE_UNAVAILABLE",
              ...(lastKnown.has(source.definition.id)
                ? {
                    lastKnown: structuredClone(
                      lastKnown.get(source.definition.id),
                    ),
                  }
                : {}),
            });
          } finally {
            clearTimeout(timer);
            controller.abort();
            signal?.removeEventListener("abort", abort);
          }
        }),
      );
    },
  });
}

export function compareCurrentObservations(observations, scope, project) {
  if (!Array.isArray(observations) || typeof project !== "function")
    fail("OBSERVATION_COMPARISON_INVALID");
  const current = observations.filter(
    (x) => x.scope === scope && x.status === "CURRENT",
  );
  if (current.length === 0) return { status: "UNAVAILABLE", sourceIds: [] };
  const claims = current.map((x) =>
    JSON.stringify(project(structuredClone(x.data))),
  );
  return {
    status: claims.every((x) => x === claims[0]) ? "CURRENT" : "CONFLICTING",
    sourceIds: current.map((x) => x.sourceId),
  };
}
