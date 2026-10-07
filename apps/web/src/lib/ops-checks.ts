/**
 * Operator status classification — #110 §2 M6.3, read-only half.
 *
 * M6.3 asks for monitoring, log aggregation and alerting. The durable probe-and-incident engine for
 * it lives on a separate draft (#66) and is not in this branch; this module is deliberately **not**
 * that. It classifies what the running system can attest right now, from sources that already
 * exist, and it:
 *
 *   - **stores nothing.** No incident record, no queue, no retention. A reload re-reads reality.
 *   - **notifies nobody.** Nothing here is alerting, and the surface that uses it says so.
 *   - **asserts nothing it did not observe.** A check that could not run reports `not-checked`,
 *     never `ok`. `ACCEPTANCE.md` §3 excludes an operator statement without evidence, and a status
 *     page that turns silence into green is exactly that.
 *
 * The functions are pure so each verdict is provable without a network, and so the one rule that
 * matters most — an unreachable dependency is never healthy — is a test rather than a hope.
 */

export type CheckState = "ok" | "degraded" | "unavailable" | "not-checked";

export type CheckVerdict = {
  state: CheckState;
  detail: string;
};

/** Freshness beyond which a mirrored observation is reported as stale rather than current. */
export const mirrorStaleAfterSeconds = 15 * 60;

/** Block age beyond which the chain view is reported as lagging. */
export const chainLagAfterSeconds = 5 * 60;

export function classifyWebRuntime(payload: unknown): CheckVerdict {
  if (typeof payload !== "object" || payload === null) {
    return { state: "unavailable", detail: "The web runtime did not answer." };
  }
  const body = payload as { status?: string; chainId?: number };
  if (body.status !== "ok") {
    return {
      state: "unavailable",
      detail: `The web runtime reports status ${body.status ?? "unknown"}.`,
    };
  }
  return {
    state: "ok",
    detail: "Serving, and reporting its configured chain.",
  };
}

export function classifyApiRuntime(
  reachable: boolean,
  httpStatus?: number,
): CheckVerdict {
  if (!reachable) {
    // Named as unreachable rather than down: this process cannot tell the difference.
    return {
      state: "unavailable",
      detail: "The API did not answer this runtime's health request.",
    };
  }
  if (httpStatus !== 200) {
    return {
      state: "degraded",
      detail: `The API answered with HTTP ${httpStatus}.`,
    };
  }
  return { state: "ok", detail: "Answering its health endpoint." };
}

/**
 * The chain view. A reported chain ID that differs from the configured one is `unavailable`, not
 * `degraded`: reading the wrong chain is worse than reading none, because every figure downstream
 * would look plausible and be wrong.
 */
export function classifyChain(
  observed:
    | { chainId: number; blockNumber: bigint; blockTimestampSeconds: number }
    | undefined,
  expectedChainId: number,
  nowSeconds: number,
): CheckVerdict {
  if (!observed) {
    return {
      state: "unavailable",
      detail: "No chain endpoint answered, so no block was read.",
    };
  }
  if (observed.chainId !== expectedChainId) {
    return {
      state: "unavailable",
      detail: `The endpoint reports chain ${observed.chainId}; this build is configured for ${expectedChainId}.`,
    };
  }
  const age = Math.max(
    0,
    Math.round(nowSeconds - observed.blockTimestampSeconds),
  );
  if (age > chainLagAfterSeconds) {
    return {
      state: "degraded",
      detail: `Head block ${observed.blockNumber} is ${age} seconds old.`,
    };
  }
  return {
    state: "ok",
    detail: `Head block ${observed.blockNumber}, ${age} seconds old.`,
  };
}

/**
 * Mirror freshness. An empty mirror is `not-checked`, never `ok`: no observation is not the same as
 * a healthy quiet market, and `ACCEPTANCE.md` §7.7 fails an audit that presents the two alike.
 */
export function classifyMirror(
  newestObservationISO: string | undefined,
  nowMilliseconds: number,
): CheckVerdict {
  if (!newestObservationISO) {
    return {
      state: "not-checked",
      detail: "No mirrored observation exists to measure freshness against.",
    };
  }
  const observed = Date.parse(newestObservationISO);
  if (!Number.isFinite(observed)) {
    return {
      state: "unavailable",
      detail: "The newest mirrored observation carries no readable timestamp.",
    };
  }
  const age = Math.round((nowMilliseconds - observed) / 1000);
  if (age < 0) {
    return {
      state: "degraded",
      detail: "The newest observation is timestamped in the future.",
    };
  }
  if (age > mirrorStaleAfterSeconds) {
    return {
      state: "degraded",
      detail: `The newest observation is ${Math.round(age / 60)} minutes old.`,
    };
  }
  return { state: "ok", detail: `Newest observation is ${age} seconds old.` };
}

/** A contract this build points at, and whether it answered a read. */
export function classifyContract(
  configured: boolean,
  readable: boolean | undefined,
): CheckVerdict {
  if (!configured) {
    return {
      state: "not-checked",
      detail: "No address is configured in this build, so nothing was read.",
    };
  }
  if (readable === undefined) {
    return { state: "not-checked", detail: "The read has not completed." };
  }
  return readable
    ? { state: "ok", detail: "Answered a read on the configured chain." }
    : {
        state: "unavailable",
        detail: "The configured address did not answer a read.",
      };
}

/**
 * The page's single summary line.
 *
 * `not-checked` never improves the summary and never worsens it into a false alarm — it is absence
 * of evidence, and it is reported as its own thing.
 */
export function summarise(verdicts: readonly CheckVerdict[]): CheckVerdict {
  if (verdicts.length === 0) {
    return { state: "not-checked", detail: "Nothing was checked." };
  }
  const count = (state: CheckState) =>
    verdicts.filter((verdict) => verdict.state === state).length;

  const unavailable = count("unavailable");
  const degraded = count("degraded");
  const unchecked = count("not-checked");

  if (unavailable > 0) {
    return {
      state: "unavailable",
      detail: `${unavailable} of ${verdicts.length} checks could not be satisfied.`,
    };
  }
  if (degraded > 0) {
    return {
      state: "degraded",
      detail: `${degraded} of ${verdicts.length} checks are degraded.`,
    };
  }
  if (unchecked > 0) {
    return {
      state: "not-checked",
      detail: `${unchecked} of ${verdicts.length} checks did not run. Nothing is claimed for them.`,
    };
  }
  return { state: "ok", detail: `All ${verdicts.length} checks answered.` };
}
