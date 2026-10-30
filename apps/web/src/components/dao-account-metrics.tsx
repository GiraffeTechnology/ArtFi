import { formatUnits } from "viem";

function units(value: bigint) {
  const [whole, fraction = ""] = formatUnits(value, 18).split(".");
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole;
}

/** Cached personal query values never render outside their authenticated view. */
export function DaoAccountMetrics({
  authenticated,
  balance,
  votes,
  totalSupply,
  balanceKnown,
  votesKnown,
  supplyKnown,
}: {
  authenticated: boolean;
  balance: bigint;
  votes: bigint;
  totalSupply: bigint;
  balanceKnown: boolean;
  votesKnown: boolean;
  supplyKnown: boolean;
}) {
  const hidden = "Sign in to view";
  const unavailable = "Unavailable";
  const ownership =
    !balanceKnown || !supplyKnown || totalSupply <= 0n
      ? unavailable
      : `${Number((balance * 10_000n) / totalSupply) / 100}%`;
  return (
    <>
      <div>
        <dt>Token balance</dt>
        <dd>
          {!authenticated
            ? hidden
            : balanceKnown
              ? units(balance)
              : unavailable}
        </dd>
      </div>
      <div>
        <dt>Voting power</dt>
        <dd>
          {!authenticated ? hidden : votesKnown ? units(votes) : unavailable}
        </dd>
      </div>
      <div>
        <dt>Ownership</dt>
        <dd>{!authenticated ? hidden : ownership}</dd>
      </div>
    </>
  );
}
