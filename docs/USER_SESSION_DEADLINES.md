# Access-token and durable-session deadlines

An open page previously scheduled only the durable session expiry. An access
cookie could expire while the page still reported authentication until focus,
visibility, a cross-tab message or a trading action caused a server recheck.

The session provider now watches both server-supplied deadlines. At access expiry
it removes local authenticated readiness immediately and uses the existing
serialized session check and 401-to-refresh path. The durable session remains
eligible for refresh, without a new wallet signature. Temporary failure retains
the durable session and retries after 15 seconds. Durable expiry still clears
local state while an earlier network check is pending.

Timer callbacks match the current session ID and both deadlines. Refresh,
sign-out, wallet changes and provider cleanup replace or retire the scheduled
work. Cleanup prevents further timer work; it does not pretend to cancel a
cookie mutation already in flight. Existing cookie serialization, unknown-result
retirement, cross-tab checks and trading-time verification remain in force.

Client session parsing also rejects an empty or oversized session ID and an
access expiry beyond the durable expiry, consistent with the existing server
contract. Neither a timer nor local readiness grants financial authority.

Synthetic controller and timer tests exercise expiry, refresh, retry, stale
callbacks, cleanup and outstanding-request races. They do not establish real
cookies, browser mounting, database revocation or public-chain acceptance.
