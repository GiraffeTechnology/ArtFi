# Native fractional market analytics

`GET /v1/market/native-analytics` is a public, read-only projection of the existing
ArtFi indexer's native fractional fills. It extends the market-history and
analytics requirements; it does not establish a valuation, price oracle, holder
registry, settlement authority or production readiness.

Supply exactly one `chainId=560048`, `marketAddress`, `assetToken` and
`paymentToken`. Addresses must be nonzero and the two tokens must differ. Unknown,
duplicate, malformed or unsupported query fields are rejected. The existing
authenticated indexer and stored signed-order admission remain unchanged.

The API reads `chain_events` and matching `native_signed_orders` from one bounded,
read-only repeatable-read database snapshot. A fill contributes only when its
indexed confirmation, nonremoved status, transaction/block identity, original
fractional terms, exact quantity/payment multiplication and same-transaction
token transfer quantities agree. Repeated identical log identities are counted
once; conflicting identities make the result unavailable. Pending, removed and
unmatched fills remain separately visible. They never become completed trades.

Prices and amounts are decimal strings in exact token base units. A block number
is also a decimal string. Price observations retain transaction hash, block hash
and log index and are ordered by block/log position. Indexer observation time is
never represented as block time. No token decimal, exchange rate or fiat value is
guessed. Different markets, assets and payment currencies are separate series.

The result describes a bounded indexed subset, not complete chain history or an
independent finality check. The newest 200 matched price observations are returned
with an explicit history truncation flag. Totals cover all accepted observations
within the 20,000-evidence-row bound; exceeding that bound suppresses every total
and price rather than presenting a partial market total. Participant counts are
participants in accepted trades. They are not a count or distribution of all
token holders; `holderDistribution` is explicitly unavailable.

The database read has a three-second deadline, a 64 KiB event-payload bound,
a 32 KiB signed-order bound and a 4 MiB combined evidence budget. SQL bounds the
returned text before decoding. An oversized or malformed record aborts the whole
read without returning partial totals.

Database outages and incomplete snapshot reads return sanitized errors without
sample data. This stage supplies the API and focused regression definitions.
Approved-source UI composition, whole-receipt and external-venue analytics,
complete holder snapshots and actual database/runtime acceptance remain separate
unfinished stages. Existing receipt, charity, wallet, signed settlement and
reorganization rules retain their own authority and evidence.
