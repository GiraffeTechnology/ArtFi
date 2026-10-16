# Charity sellout and physical-donation evidence recording

The existing charity editions contract has two recorder-only methods:
`recordSellout(tokenId, evidenceHash)` and
`recordPhysicalDonation(tokenId, evidenceHash)`. The charity detail screen
exposes an exact-call review for those methods with the existing configured
collection and Hoodi network. No new contract, role, endpoint or deployment
address is introduced.

The evidence hash must already come from independent review. The screen
accepts a nonzero bytes32 commitment and an explicit acknowledgement; it
does not upload evidence, generate an acceptance document, reconcile external
sales automatically, or treat a checked box as independent verification.
The recorder remains responsible for that review. Zero distributor balance
is necessary for sellout recording and is not proof of purchases. Physical
donation acceptance follows the recorded sellout. Existing on-chain pause,
role, one-time record and evidence-hash gates remain authoritative.

Preflight reads the series, pause and original distribution balance at one
observed block, rechecks the actual recorder role route and simulates the
call. A role-holding configured Safe takes precedence and requires a real
Safe owner. Its exact selector, token ID, evidence hash, target and zero-value
proposal are reviewed through the existing Safe threshold/timelock/recovery
flow. The existing exact-calldata request-ID helper is reused; no receipt
business commitment or new cryptographic encoding is defined.

Direct calls use the existing browser recovery session. An unresolved wallet
request survives navigation and refresh, including a late returned hash.
Unknown results block another direct record and are checked using the
original transaction. Sender, target, exact input and zero ETH value are
verified for direct recovery and repriced transactions. User rejection and
known final cancellation/reversion remain distinct from unknown results.
Safe recovery retains the existing independently reviewed proposal and may
verify execution by another owner.

Completion requires the exact collection event and token/evidence arguments,
the recorded hash and timestamp at the receipt block, and a matching canonical
block hash. An event, receipt, or state mismatch is not completion. Refreshing
edition facts rereads current state; a previous observation is not perpetual
finality. No new sale, transfer, tax receipt, donation entitlement or physical
right is created by this UI. Charity masters and private originals are never
uploaded or previewed.

Initial source includes synthetic boundary, routing, receipt and static-render
regressions. Ordinary tests, compilation, browser interaction, Safe multi-owner
acceptance and genuine chain verification must be recorded independently for
the exact submitted source. Authored tests and formatting are not a PASS.
