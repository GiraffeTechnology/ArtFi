import { formatUnits } from "viem";

const uint256 = (value: unknown): value is bigint =>
  typeof value === "bigint" && value >= 0n && value < 1n << 256n;

/** A display of the selected proposal's reads, never execution authority. */
export function DaoSnapshotWeight({
  snapshot,
  snapshotKnown,
  weight,
  weightKnown,
  authenticated,
}: {
  snapshot?: bigint;
  snapshotKnown: boolean;
  weight?: bigint;
  weightKnown: boolean;
  authenticated: boolean;
}) {
  const hasSnapshot = snapshotKnown && uint256(snapshot);
  const hasWeight =
    authenticated && hasSnapshot && weightKnown && uint256(weight);
  return (
    <>
      <div>
        <dt>Proposal snapshot block</dt>
        <dd data-no-translate data-translation-skip>
          {hasSnapshot ? snapshot.toString() : "Unavailable"}
        </dd>
      </div>
      <div>
        <dt>Your snapshot voting power</dt>
        <dd>
          {hasWeight ? (
            <>
              <span data-no-translate data-translation-skip>
                {formatUnits(weight, 18)}
              </span>{" "}
              voting tokens ({" "}
              <code data-no-translate data-translation-skip>
                {weight.toString()}
              </code>{" "}
              base units)
            </>
          ) : (
            "Unavailable"
          )}
        </dd>
      </div>
    </>
  );
}
