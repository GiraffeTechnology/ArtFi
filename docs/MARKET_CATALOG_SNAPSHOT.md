# One-request catalog snapshots

Catalog count and page queries now use the same read-only Repeatable Read transaction. A concurrent indexer insert, cancellation or order update cannot supply the total from one committed state and page data from another within that response. The existing parameterized source/contract/search/status filters, lossless token sorting and response schema remain unchanged.

Rows are closed and the read transaction is completed before a successful catalog response is written. Snapshot-open, row and completion errors return a bounded unavailable response; the handler does not fall back to pool-level reads. Deferred rollback releases an unfinished snapshot on every early return. Trade intent creation, fulfillment, submission and financial paths are unchanged.

This scope is one response, not a cursor binding multiple requests to one historical dataset. A later request deliberately observes later commits. Added regression definitions use a separate connection to commit an insert or cancellation after a real MySQL read view is established, then require coherent old data and a fresh subsequent request. Integration data and cleanup are scoped to a unique test contract; existing other rows are retained.

The new tests require the existing isolated integration MySQL DSN and migrations. A missing DSN is explicitly NOT_RUN. Source formatting, authored definitions or a source archive are not MySQL/runtime acceptance.
