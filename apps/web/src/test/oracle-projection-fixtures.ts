// TEST_ONLY Oracle application responses; no live registry or legal-title claim.
import type { ProjectionRead } from "../lib/oracle-projection-model";

export const projectionSourceFixture = {
  chainId: "560048",
  contract: "0x1000000000000000000000000000000000000002",
  registerId: `0x${"a".repeat(64)}`,
};
export function projectionFixture(instant = "1500"): ProjectionRead {
  return {
    ok: true,
    tokenId: "1",
    instant,
    source: { ...projectionSourceFixture },
    entryCount: "2",
    entry: {
      ok: true,
      value: {
        recordCommitment: `0x${"b".repeat(64)}`,
        previousCommitment: `0x${"0".repeat(64)}`,
        registryReference: `0x${"c".repeat(64)}`,
        holder: `0x${"1".repeat(40)}`,
        version: "1",
        effectiveAt: "1000",
        supersededAt: "2000",
      },
    },
    holder: { ok: true, value: `0x${"1".repeat(40)}` },
    finality: { ok: true, value: true },
    position: { ok: true, value: `0x${"2".repeat(40)}` },
    readAt: "2026-10-03T18:00:00.000Z",
  };
}
