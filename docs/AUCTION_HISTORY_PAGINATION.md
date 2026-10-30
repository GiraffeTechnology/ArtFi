# Auction history navigation

The auction workbench adds a public history browser alongside its existing live
state view. Existing bid, creation, settlement, credit, authenticated-session and
fresh-state execution checks are unchanged. History navigation dispatches no
wallet action and is never an execution preflight or financial authority.

Each manual read uses the existing configured Hoodi client and auction contract.
The initial page pins a block number and hash. Older and newer pages carry that
same anchor, auction, contract and block span. Cursors are strict, bounded own-data
snapshots with canonical integer strings and a version discriminator. They are
navigation data only, not signed grants or backend authority. Newest-page reads
deliberately start a new snapshot; later head growth never slips into an older
page's anchor. Covered inclusive ranges are disjoint, contiguous and can be
walked to block zero. An anchor reorg requires a new snapshot.

The reader queries each fixed auction event with its actual indexed listing ID;
it does not download every auction and silently filter the result into a false
empty page. Returned events retain complete transaction/block/log provenance,
exact base-unit values and existing ABI checks. Identical duplicates are counted
once, conflicting identities or block/log positions are refused. Every observed
block hash is checked against a requested block header, followed by a final chain
and anchor read. Partial, removed, misbound or changed-source results are not
returned as a successful page.

Block spans range from 1 to 10,000; the UI offers 10, 100, 1,000 and 10,000. A
response at or above 1,000 records, an aggregate reaching that cap or more than
64 observed event blocks is refused as dense. The user can select fewer blocks.
At most five event calls run together and header verification runs in drained
batches of four. These bounds apply to retained page data and application calls;
the existing RPC transport retains its own response-body, timeout, cancellation
and provider trust behavior. Header checks are not a cryptographic completeness
proof against a dishonest or silently omitting RPC provider.

The browser retains only the current block page. It supports event-type and
actor/transaction/request filtering and ordering within that page, with at most
50 rendered event rows. Filtered-empty, source-empty and unavailable responses
have distinct explanations. No all-history completeness claim is inferred from
an empty range or filter. Public identities and amounts are displayed exactly;
human labels remain authoritative English inputs to the existing language layer.
Responsive controls and wrapping source hashes support the existing mobile view.

Reads are manual and sequential, with no new timer, browser storage or automatic
retry. Hiding the page clears it, aborts its logical generation and fences late
results. The actual pending read retains its slot until it settles, preventing
overlapping retries merely because a screen was hidden or a response was late.
Cancellation does not claim that an RPC transport has terminated its requests.
Explicit retries reuse an existing requested cursor when one was established;
retrying an initial newest query selects a fresh head. A source/context change
constructs a new controller; an old controller cannot restore its page there.

Authored regressions cover anchor-preserving navigation, genesis boundaries,
indexed event queries, duplicate/source provenance, immutable cursor snapshots,
foreign/getter/alias/overflow cursors, reorgs, changed chains, dense ranges,
misbound/removed logs, cancellation, diagnostic redaction, sequential visibility
handling, explicit retry, hostile error objects, render row bounds and source
availability distinctions. These fixtures do not establish real RPC/browser or
chain acceptance. Three separate bounded controller author checks actually ran
on existing Linux Node 24.18.0 with matching source SHA-256 and exit 0: manual
single-flight/visibility fencing, cursor-preserving explicit retry, and refusing
to execute an error-code getter. They did not execute the RPC reader or renderer.
The complete TypeScript, unit, rendered desktop/mobile and existing auction
transaction regressions still require exact-source execution.
