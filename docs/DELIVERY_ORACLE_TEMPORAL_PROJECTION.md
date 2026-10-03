# Oracle temporal projection application integration

## Existing requirement and bounded change

The whole-artwork ERC-8415 receipt product already requires ArtFi to consume
Oracle's application-facing boundary. ArtFi main `033dba4ff8a89e23e70f750625c0994b7d69c5bc`
reads Oracle asset/token/certificate status, but that older API does not expose
the temporal register holder. Oracle PR #44 contained a compatible unmerged
projection API. This increment consumes its separately repaired forward port;
it does not put an ERC-8415 or Kit adapter, projection contract, wallet provider,
mint authority, or settlement mechanism into ArtFi.

The existing whole-artwork detail page now reads a requested Unix instant and
shows the recorded holder, temporal finality, ERC-721 tradeable position, entry
version, effective interval, commitments and registry reference separately.
The initial read uses the current Unix time; the user can query an exact historical
instant. A refresh re-reads that requested instant. No read opens a wallet prompt.

An uncovered instant leaves entry/holder unavailable while an independently
reported false finality stays false. An unavailable read is not an empty register,
a false finality result, or permission to substitute `ownerOf`. This read-only
projection surface does not expose settlement gaps and makes no claim that none
exist. Temporal finality is not freshness, chain economic finality or legal title.

## Application boundary

ArtFi exposes one same-origin GET route:
`/api/assets/{slug}/projection?instant={uint64-decimal}`.
It resolves only the existing configured whole-artwork slug, Hoodi chain,
collection and uint256 token ID. The browser cannot supply an upstream URL,
collection, credentials, source binding or extra query parameters.

The server consumes only Oracle's `/v1/oracle/projection/{tokenId}` identity,
`entry/as-of`, `holder/as-of`, `finality/as-of` and `position` routes. The
configured chain/collection and checked register ID must agree across successful
responses and a final identity re-read. The entry interval must cover the exact
requested instant. Calls remain separate observations, not an atomic snapshot.

Oracle's `source.chainId` and `source.contract` describe its configured deployment
binding. They are not cryptographic evidence of chain/contract identity. Oracle
checks its pinned register ID against its Kit source. The operations owner must
verify the configured source binding before runtime acceptance. ArtFi displays
this distinction and does not create authority from an HTTP response.

Unknown/private fields are stripped. Requests omit credentials and cookies,
refuse redirects, and bound the whole response stream to four seconds and 64 KiB.
Errors expose stable public codes only. Cached facts are hidden while refreshing,
offline or switching the queried instant. Other artwork pages cannot reuse the
configured token's projection.

## Non-secret deployment requirements

This source change performs no deployment. ArtFi reuses the existing server-only
`ARTFI_ORACLE_READ_API_URL` and existing whole-artwork public bindings; no new
ArtFi credential or public environment input is added. The existing bridge path
prefix is retained. Do not configure ArtFi directly against Kit.

The Oracle dependency must be the reviewed forward-port revision with its
application routes and startup factory wired. Its deployment owner supplies the
existing approved Kit read endpoint and verified binding through:

- `GIRAFFE_ORACLE_KIT_READ_API_URL`
- `GIRAFFE_ORACLE_PROJECTION_CHAIN_ID`
- `GIRAFFE_ORACLE_PROJECTION_CONTRACT`
- `GIRAFFE_ORACLE_PROJECTION_REGISTER_ID`

These are a deployment contract, not authorized values. Missing or mismatched
configuration remains visibly unavailable. Preserve SIN/CTYun separation, existing
bridge allocations and existing reserved listeners. No SSH, port, credential,
real-chain, or real-asset action is part of this change.

After deployment, the existing owner should verify the served ArtFi SHA, the
Oracle revision and the configured source identity; exercise a covered and an
uncovered instant, owner/holder divergence, source outage/retry, historical query,
desktop/mobile navigation and recovery. Record actual runtime evidence separately
from the isolated source fixtures. Existing transaction acceptance remains separate.

## Development evidence

Local current candidate: 565 Web unit cases, including 44 new projection/paused
state cases, full Web lint and TypeScript pass. Six additional in-process
cross-repository checks exercised the actual repaired Oracle application handler
through ArtFi's transport/parser, including the exact `EMPTY_PROJECTION` error,
uncovered-instant asymmetry, source failure, false finality and absent position.
Those checks use TEST_ONLY source records, not a deployed institutional registry.

Eight new desktop/mobile browser cases are registered in the existing
`oracle-browser` CI job, alongside its 14 existing cases. Local Chromium fails
before any page opens because the runtime denies its process singleton socket;
no local browser pass or screenshot is claimed. Exact-head hosted CI must run
these cases. The production build result and subsequent CI evidence are recorded
on the PR, not inferred from source presence. No production or complete-product
acceptance is claimed.
