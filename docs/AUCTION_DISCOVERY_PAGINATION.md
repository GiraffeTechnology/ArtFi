# Public auction discovery across older blocks

The auction workbench now exposes public listing discovery before any auction is selected. It retains the recent-ID shortcut and delegates a selected result to the existing fresh inspection path. A historical discovery row never grants bid, settlement, withdrawal or signing authority.

## Source and pagination

The configured public client and market remain the only source. Discovery verifies the configured chain, pins a block hash and reads the fixed `ListingCreated` event from bounded, contiguous source windows. Within a window it walks at most 50 creation candidates per page using the complete immutable event identity, then continues to disjoint older windows down to genesis. Newer navigation reverses this order against the same anchor. Empty windows remain navigable.

An optional public seller filter is applied to the indexed event query and bound into every cursor. No seller gets a preferred discovery or settlement path. Contract-state filtering applies only to the displayed candidate page, not to all auctions. Source windows are 1–10000 blocks at the reader boundary; the UI offers 10, 100, 1000 and 10000. Dense responses with 1000 or more records fail closed rather than claiming complete discovery.

The reader validates selected creation headers and the continuation boundary, reads the actual 11-output listing getter at the anchor, verifies the seller and contract kind, excludes known fixed-price records, and rechecks the anchor and chain before returning. Detail/header batches launch at most four operations at a time and drain a batch before reporting failure. SDK-decoded uint8/uint48 values are safe numbers; uint256 values remain bigint. Missing records, conflicting identities, malformed tuples, changed sources and failed calls produce no partial successful page. Provider omission and a hanging transport remain limitations of the configured RPC; this UI does not claim cryptographic log-completeness proof or impose a new transport timeout.

The versioned cursor is copied from exact own data properties, with bounded canonical fields and a full event boundary. It is navigation data, never source, authentication or financial authority. Only the current page remains in memory. Requests are manual, actual reads do not overlap within a pager, hidden or replaced contexts cannot restore old rows, and retries are explicit. There is no polling, persistent history cache or background scan.

## Integration and validation

Discovery performs no balance, holdings, allowance, approval, credit, wallet connection or financial write. Public listing observations are distinct from authenticated personal history. Opening a result uses the unchanged workbench inspection and existing fresh transaction guards.

The shared pager retains the existing per-auction history wrapper signature. New regression sources cover candidate and block navigation, exact cursor/filter binding, duplicate/conflict/refusal behavior, locked SDK ABI shapes, bounded detail reads/cancellation, shared-controller compatibility, and static rendering/provenance. Static display and synthetic callbacks do not establish real RPC, browser, transaction or product acceptance. Actual validation status is recorded separately for the precise submitted source; prior-stage results are not inherited after this refactor. Applicable runtime, full type/build, browser and independent acceptance remain required.
