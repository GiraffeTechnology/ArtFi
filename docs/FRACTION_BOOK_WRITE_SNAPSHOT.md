# Fraction book read and approval boundaries

The fractional order book retains its deterministic price-time-hash priority,
reviewed maximum quantities and total payment limit. It does not reserve an
order or hold assets during preview. Each fill is a separate atomic transaction;
earlier confirmed fills remain final if a later fill fails.

Payment approval now revalidates the catalog and signed fill inside the actual
approval callback, after the asynchronous trading-session gate. Settlement keeps
its separate post-approval check inside the authenticated fill callback. A
revoked, expired, consumed or newly unaffordable order must not proceed using a
check made before the session wait. Existing current-operation retirement,
receipt confirmation and unknown-result journal handling remain in force.

Complete order-book reads have a 12-second result deadline. Timeout discards the
preview result; it does not claim to cancel provider requests. Initial block
number, timestamp and hash must be valid, market flags must be exact booleans,
and payment state must be uint256 bigints. The final read rechecks chain ID,
block number, hash and timestamp before returning a preview. An all-zero order
log digest and an unknown signature verdict do not establish usable evidence.

These checks use one read snapshot and do not prevent a competing settlement
afterward. Contract-side cumulative consumption, revocation, expiry, balance,
allowance and atomic settlement checks remain authoritative. No additional
signature is demanded for each partial fill beyond the existing signed terms.

Regression definitions cover malformed observations, reader changes, bounded
waiting, late results and timer cleanup. Verification status is recorded with
the exact candidate; authored cases and source formatting are not proof of
executed tests, real wallet operations or deployed-chain acceptance.
