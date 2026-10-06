# Portfolio authentication boundary

The public Xiongan Wallet entry remains available without login. ArtFi's personal portfolio
requires a separate authenticated wallet session before displaying balances, holdings, or
transaction history. Merely connecting an address does not satisfy this requirement.

## Implementation

- `portfolioSessionKey` checks the existing session provider and the current wallet during
  render. A logout, expiry, disconnected wallet, changed address, or changed chain immediately
  prevents asset panels from mounting, even before the provider processes a wallet-change effect.
- The balance query is scoped to the session ID, address, and chain, with zero cache retention
  after unmount. A prior session's cached balance cannot populate a newly authenticated view.
- Indexed positions and history are fetched only while the matching authenticated panel is
  mounted. Unmount aborts the request; delayed responses and JSON parsing cannot restore
  holdings after logout or wallet replacement.
- `GET /api/portfolio/{address}` verifies the existing HTTP-only-cookie session and exact
  wallet binding before requesting upstream records. It fails closed on absent, mismatched,
  expired, or unavailable authentication. Requests and responses are no-store; upstream data
  is bounded and checked for the expected address and Hoodi chain.
- The underlying blockchain/indexer source remains public data. This personal-display boundary
  does not claim to make publicly observable chain records private.

## Verification

Unit coverage includes connection without login, logout, expiry, account/chain changes,
session-specific cache identity, aborted late reads, missing/mismatched server authentication,
upstream errors, and response identity checks. The browser suites exercise the same UI
transitions with explicit fixtures and verify real isolated SIWE login, portfolio access,
logout, and reload against the test authentication service.

Exact-head CI is the source of browser results. Source presence or a unit test is not evidence
of production deployment. Xiongan Wallet is a separate 8415 Wallet tenant: this ArtFi change
does not establish that the separate wallet application's asset-display login is enforced.
