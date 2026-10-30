// Operational provider preference can learn reliability, never permission.
// Candidates are passed by the fixed composition and must share exact scope.
const fail = (code) => {
  throw Error(code);
};
const id = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(x);
export function rankApprovedProviders(approved, statistics, scope) {
  if (
    !Array.isArray(approved) ||
    approved.length < 1 ||
    approved.length > 32 ||
    !id(scope) ||
    new Set(approved.map((x) => x.id)).size !== approved.length ||
    approved.some(
      (x) =>
        !id(x.id) || !Array.isArray(x.scopes) || x.scopes.some((s) => !id(s)),
    )
  )
    fail("PROVIDER_CONFIGURATION_INVALID");
  const stats = statistics && typeof statistics === "object" ? statistics : {};
  return approved
    .filter((x) => x.scopes.includes(scope))
    .map((provider, index) => {
      const stat = stats[provider.id];
      const valid =
        stat &&
        Number.isSafeInteger(stat.successes) &&
        stat.successes >= 0 &&
        Number.isSafeInteger(stat.failures) &&
        stat.failures >= 0;
      const score = valid
        ? (stat.successes + 1) / (stat.successes + stat.failures + 2)
        : 0.5;
      return { id: provider.id, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.id);
}
export function createProviderRecovery({
  providers,
  scope,
  timeoutMs = 2000,
  clock = Date.now,
}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 30000 ||
    typeof clock !== "function" ||
    !Array.isArray(providers) ||
    providers.some((x) => typeof x.read !== "function")
  )
    fail("PROVIDER_CONFIGURATION_INVALID");
  const fixed = providers.map((x) => ({
    id: x.id,
    scopes: structuredClone(x.scopes),
    read: x.read.bind(x),
  }));
  rankApprovedProviders(fixed, {}, scope);
  const statistics = Object.fromEntries(
    fixed.map((x) => [x.id, { successes: 0, failures: 0 }]),
  );
  let preference = [];
  return Object.freeze({
    snapshot: () => ({
      scope,
      statistics: structuredClone(statistics),
      preference: [...preference],
      authorityModified: false,
    }),
    async read(request, signal) {
      preference = rankApprovedProviders(fixed, statistics, scope);
      const attempts = [];
      for (const id of preference) {
        if (signal?.aborted) break;
        const provider = fixed.find((x) => x.id === id),
          controller = new AbortController();
        let timer;
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const result = await Promise.race([
            provider.read(structuredClone(request), controller.signal),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(Error("PROVIDER_TIMEOUT"));
              }, timeoutMs);
            }),
          ]);
          if (signal?.aborted) throw Error("PROVIDER_ABORTED");
          if (result?.status !== "CURRENT") throw Error("PROVIDER_NOT_CURRENT");
          statistics[id].successes = Math.min(
            Number.MAX_SAFE_INTEGER - 1,
            statistics[id].successes + 1,
          );
          attempts.push({ providerId: id, state: "CURRENT" });
          return {
            state: "RECOVERED",
            providerId: id,
            observedAt: clock(),
            attempts,
            value: structuredClone(result),
          };
        } catch {
          statistics[id].failures = Math.min(
            Number.MAX_SAFE_INTEGER - 1,
            statistics[id].failures + 1,
          );
          attempts.push({ providerId: id, state: "UNAVAILABLE" });
        } finally {
          clearTimeout(timer);
          controller.abort();
          signal?.removeEventListener("abort", abort);
        }
      }
      return {
        state: "SAFE_DEGRADED",
        observedAt: clock(),
        attempts,
        reason: "APPROVED_PROVIDERS_UNAVAILABLE",
      };
    },
  });
}
