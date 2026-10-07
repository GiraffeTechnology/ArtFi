import type { OracleReadResponse } from "./oracle-read-model";

type ReadQuery = {
  isPaused: boolean;
  isPending: boolean;
  isFetching: boolean;
  data?: OracleReadResponse;
};

type ReadView =
  | { phase: "paused" | "loading"; result?: undefined }
  | { phase: "settled"; result: OracleReadResponse };

/** A paused refetch may retain successful cached data without being fetching.
 * Do not render that cache as the outcome of the requested current read. */
export function oracleReadView(query: ReadQuery): ReadView {
  if (query.isPaused) return { phase: "paused" };
  if (query.isPending || query.isFetching) return { phase: "loading" };
  return {
    phase: "settled",
    result: query.data ?? { ok: false, code: "ORACLE_UNAVAILABLE" },
  };
}
