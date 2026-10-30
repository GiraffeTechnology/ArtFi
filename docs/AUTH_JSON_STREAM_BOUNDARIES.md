# Authentication body bounds and uncertain responses

The ordinary wallet login retains its existing BFF signature verification,
independent server bridge, durable challenge consumption, sessions and scoped
HttpOnly cookies. This change does not add credentials or change signing rules.

The browser previously consumed a complete response with `text()` before checking
its character count. Authentication JSON now uses one shared browser/server
reader that counts actual stream bytes against the existing 16,384-byte limit
before decoding. UTF-8 decoding is strict, including code points split across
chunks; malformed or incomplete sequences fail rather than becoming replacement
characters. Content-Length does not replace the actual byte count.

The reader honors an external abort and its finite body deadline. The existing
8-second upstream and 25-second browser signals cover both header acquisition and
body consumption. Cancellation is best effort and is not awaited: a stream's
unresolved cancellation promise cannot extend the response deadline. No claim is
made that a remote operation was cancelled or rolled back.

An unreadable successful verification response remains uncertain.
The client returns its existing `cookiesMayHaveChanged` marker so the controller
retains durable logout/retirement before a later cookie write. A failed session
read remains distinct, and known HTTP rejections retain their existing status.
Upstream payloads and decoder errors are never returned as browser diagnostics.

Verification records distinguish synthetic stream/controller checks and strict
type checks from real database sessions, actual HTTP/browser behavior, wallet
signing and deployed acceptance. Unknown outcomes are never permission to replay.
