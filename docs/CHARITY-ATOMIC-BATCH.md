# Atomic fixed-edition creation

The charity editions contract adds `createSeriesBatch(SeriesInput[])` alongside
the existing single-series method. Each input contains the same artwork ID,
private-master commitment, metadata commitment, distribution wallet and metadata
URI as `createSeries`. There is no quantity parameter: each new artwork still
has exactly 100 units, minted once. Both artwork and master commitments remain
unique within the collection.

One call accepts 1–37 inputs. This bounds an individual atomic operation and
does not limit the total number of series in a collection or other digital NFT
products. Multiple valid calls and the original single-series method can append
new unique series. The 13-work tranche and 37-work formal set fit this entry;
their selection and release evidence remain separate from this primitive.

The entire input list is validated before a recipient is called. Intra-batch
and already-registered duplicates fail. All records, supply, balances, lookup
indexes, recipient callbacks and events are part of one EVM transaction; a late
failure reverts the whole operation. The ordinary `SeriesCreated` events remain
the per-series authority for the existing indexer. The method returns the
created IDs in input order.

The original creator role and pause gate apply. Creation reentrancy is rejected
for single and batch entry points, preventing a privileged recipient callback
from interleaving another mint. Batch processing rechecks the original caller's
role and pause state after every recipient callback, including the last one.
Revocation or pause during a callback therefore aborts the complete batch.
Holder transfers stay available during pause; no burn or follow-on mint path
is introduced. Donation recording, metadata privacy and receipt policy are
unchanged. No ETH payment or settlement is performed by this contract.

## Historical and deployment boundary

This is new source capability for separately authorized deployment and isolated
testing. It does not alter an immutable deployed contract, upgrade an existing
address, migrate an asset or authorize a replay. The existing frozen Sepolia
record and its verifiers remain unchanged. A list of successful individual
transactions is not evidence of one atomic batch and must not be relabelled as
such. No real artist's records are regenerated to demonstrate this method.

An existing deployment without the new selector remains unsupported for batch
creation. Application/Safe integration must use this exact method and reviewed
runtime, simulate the full zero-value call, preserve user confirmation and
unknown-result reconciliation, and match every created series. This contract
stage does not claim that UI integration, runtime installation, Safe interaction,
gas budgets or genuine Hoodi acceptance have already been completed. The
existing deployment parameters and deployment-chain guard are unchanged.

## Authored regression scope

`CharityEditionBatch.t.sol` supplies 29 test functions, including two bounded
fuzz specifications. It uses symbolic isolated commitments labelled TESTNET,
NO REAL-WORLD VALUE and NO LEGAL EFFECT, with no real artwork, donation or
holder claim. Coverage includes 13/37-series creation, fixed per-series supply,
collection growth beyond one batch, invalid/duplicate late members, retained
older series, receiver rejection, callback-state rollback, all four creation
reentry combinations, callback pause/revocation and holder transfers during
pause. Existing single-series/recorder regressions remain relevant.

These cases are authored source, not execution evidence. Independent Linux
compile, all affected old/new tests, gas measurements for 13/37 entries and
maximum-length URIs, contract audit and approved-chain verification remain
required in their assigned validation stages. In particular, the bound does
not promise a specific gas cost for arbitrary recipient code. No mainnet,
real-value, credential or signing authorization is supplied by this document.
