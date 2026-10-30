import { kernelRequestDigest } from "./agent-kernel.mjs";
import { validateActionAuthority } from "./action-policy.mjs";
// Models may reorder existing validated candidates. They cannot supply a new
// request, edit authority or authorize execution. Deterministic fallback works
// when the model is absent, times out or proposes unknown identifiers.
export function createAdvisoryPlanner({
  store,
  ethers,
  policy,
  readCandidates,
  compile,
  authorize,
  observe,
  advise = null,
  clock = Date.now,
  timeoutMs = 1000,
}) {
  if (
    [
      store?.listPlannable,
      store?.get,
      store?.prepare,
      readCandidates,
      compile,
      authorize,
      observe,
      clock,
    ].some((x) => typeof x !== "function") ||
    (advise !== null && typeof advise !== "function") ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 5000
  )
    throw Error("PLANNER_CONFIGURATION_INVALID");
  let after = "",
    running = false;
  async function bounded(work, signal) {
    const abort = new AbortController();
    let timer;
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(abort.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(Error("PLANNER_DEPENDENCY_TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      abort.abort();
      signal?.removeEventListener("abort", cancel);
    }
  }
  return Object.freeze({
    async runBatch(signal) {
      if (running) throw Error("PLANNER_ALREADY_RUNNING");
      running = true;
      const report = {
        state: "PLANNER_BATCH_COMPLETE",
        prepared: 0,
        rejected: 0,
        dependenciesUnavailable: 0,
        advisoryFallback: false,
      };
      try {
        const authorities = await store.listPlannable({ after, limit: 4 });
        for (const stored of authorities) {
          if (signal?.aborted) break;
          after = stored.authorityKey;
          let authority;
          try {
            authority = validateActionAuthority(stored.envelope, {
              ethers,
              policy,
            });
          } catch {
            report.rejected++;
            continue;
          }
          const p = authority.envelope.intent,
            time = BigInt(Math.floor(clock() / 1000));
          if (
            time < BigInt(p.validFrom) ||
            time >= BigInt(p.validUntil) ||
            BigInt(stored.ledger?.executions ?? "0") >= BigInt(p.maxExecutions)
          )
            continue;
          let candidates;
          try {
            candidates = await bounded(
              (s) =>
                readCandidates(
                  { intent: p, intentDigest: authority.digest },
                  s,
                ),
              signal,
            );
          } catch {
            report.dependenciesUnavailable++;
            continue;
          }
          if (!Array.isArray(candidates) || candidates.length > 32) {
            report.rejected++;
            continue;
          }
          const eligible = [];
          for (const candidate of candidates) {
            if (signal?.aborted) break;
            try {
              const time = clock();
              if (
                candidate?.status !== "CURRENT" ||
                typeof candidate.sourceId !== "string" ||
                !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.sourceId) ||
                !Number.isSafeInteger(candidate.observedAt) ||
                candidate.observedAt > time + 5000 ||
                time - candidate.observedAt > policy.maxObservationAgeMs
              )
                throw Error("PLANNER_CANDIDATE_STALE");
              const request = structuredClone(candidate.request);
              delete request.operationId;
              request.operationId = `auto-${kernelRequestDigest({ intentDigest: authority.digest, sourceId: candidate.sourceId, request }).slice(0, 56)}`;
              if (await store.get(request.operationId)) continue;
              const plan = await bounded((s) => compile(request, s), signal);
              const observation = await bounded(
                (s) =>
                  observe(
                    plan.legs[0],
                    { envelope: authority.envelope, plan },
                    s,
                  ),
                signal,
              );
              authorize(authority.envelope, plan.legs[0], observation);
              eligible.push(plan);
            } catch {
              report.rejected++;
            }
          }
          eligible.sort((a, b) => {
            const av = BigInt(a.legs[0].value),
              bv = BigInt(b.legs[0].value);
            return av < bv
              ? -1
              : av > bv
                ? 1
                : a.operationId.localeCompare(b.operationId);
          });
          if (!eligible.length) continue;
          let selected = eligible[0];
          if (advise) {
            try {
              const answer = await bounded(
                (s) =>
                  advise(
                    eligible.map((x) => ({
                      id: x.operationId,
                      action: x.action,
                      value: x.legs[0].value,
                    })),
                    s,
                  ),
                signal,
              );
              if (!Array.isArray(answer)) throw Error("PLANNER_ADVICE_INVALID");
              const match = answer
                .map((id) => eligible.find((x) => x.operationId === id))
                .find(Boolean);
              if (!match) throw Error("PLANNER_ADVICE_INVALID");
              selected = match;
            } catch {
              report.advisoryFallback = true;
            }
          } else report.advisoryFallback = true;
          // At most one new pending workflow per authority per scan. Durable budget
          // checks still occur before each send, including races between planners.
          try {
            await store.prepare(authority, selected);
            report.prepared++;
          } catch {
            report.dependenciesUnavailable++;
          }
        }
        if (!authorities.length) after = "";
        if (report.dependenciesUnavailable) report.state = "SAFE_DEGRADED";
        return report;
      } finally {
        running = false;
      }
    },
  });
}
