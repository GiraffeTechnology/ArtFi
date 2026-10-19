# ArtFi engineering guide

Product scope is recorded in [docs/PRD.md](docs/PRD.md). Evidence and acceptance
criteria are recorded in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md), with historical
and current-source results in [docs/STATUS.md](docs/STATUS.md).

## 1. Product boundaries to preserve

### 1.1 Three sections and venue scope

- Retain the NFT/CCHS and charity-edition functionality. Digital NFT ownership conveys none
  of the physical-asset or redemption rights prohibited by CH.8. A donation record does not
  turn the NFT into physical backing.
- OpenSea is primary for the NFT section, not exclusive. Do not apply the old blanket
  "ArtFi is primary for every line" wording to this section.
- The NFT section at `io.artcch.com` must provide native OpenSea-backed discovery and
  trading: browse, inspect, list, buy, make and accept offers, cancel eligible orders, and
  track results through ArtFi. Use the supported official API, SDK, and settlement protocol.
  A homepage redirect, asset deep link, iframe, or read-only catalog is not this workflow.
- Keep the optional external OpenSea website link in the footer. Main NFT navigation and
  trading controls stay in ArtFi. Preserve attributed source URLs as data rather than
  substituting outbound links for product actions.
- Whole-artwork tokens have receipt/voucher semantics. Do not label their chain ownership
  as unrestricted physical title or collapse them into fractional fund tokens.
- Preserve inherited fractionalization, trading, portfolio, and DAO workflows. Their
  presence in the latest three-section description is not a new scope expansion.
- Preserve Stage 1 approved-source, machine-verifiable correspondence evidence before RWA
  minting or activation in both the whole-artwork and fractional sections. It applies to
  authenticated assets and enforceable real-world rights, including approved non-registry
  sources such as custody, warehouse, and certificate evidence. Preserve applicable ERC-8415
  identity, restriction, and lifecycle requirements, plus registry synchronization where the
  asset is registry-backed. Charity NFT independence is not a general exemption for fractions.
- Passive event ingestion remains read-only; that adapter constraint is not a prohibition
  on the native OpenSea order workflow. ArtFi prepares and relays approved requests, users
  confirm wallet actions, and the venue/protocol remains authoritative for execution.
- Preserve compatible approved adapters, source attribution, and ArtFi's own whole-artwork
  and fractional order book, matching, and settlement. The securities-website analogy
  describes the frontend/venue relationship, not licensing, custody, or new product scope.

### 1.2 Assets and authority

- The registry of record determines recorded holdership within its scope; the chain
  determines token state and settlement; ArtFi stores are read-only projections.
- On divergence, show the sources and their different claims. Never resolve a property
  question from ArtFi's database or silently equate token transfer with registry transfer.
- Registry authority belongs to the source role, not to ArtCCH as platform operator.
  ArtFi consumes registries and does not become a registry in this application.
- Disclose own-account sales, but grant ArtCCH no seller, matching, fee, visibility,
  settlement, or administrative property privilege.
- Fixed-price and order-book trading use the existing valid signed intents and atomic
  settlement. No resting custody is introduced. Preserve bounded partial fills and
  revocation, expiry, quantity, replay, and signature checks.
- Keep the existing auction escrow exception, bounded by its accepted terms and with
  settlement, credit withdrawal, and the required seller escape available during pause.
- Governance rights follow the actual asset structure; token possession does not create
  unspecified economic, voting, or physical rights.

### 1.3 Application and ecosystem

ArtFi is a commercial application, not a demo, an ERC8415-Kit repository, an Oracle implementation,
or the independent wallet product. Its application-side integrations remain in scope. Complete
only the interfaces actually needed by the current workflow; do not import every external
product milestone as a prerequisite.

The wallet product is 8415 Wallet, using a configured V2 wallet tenant. ArtFi's test entry may open without login, but wallet assets,
balances, holdings, and history require an authenticated session. Opening a wallet page or
connecting an address is not login, shared session establishment, or authority to sign.
Preserve production authentication and existing wallet-confirmation boundaries. Consume the
complete deployment-supplied wallet destination setting through the no-store runtime route;
never hardcode a destination or port or invent a cross-origin wallet protocol.

Keep OpenSea API credentials and credential-bearing SDK calls server-side. Validate the
supported chain, asset, order, account, amount, fees, expiry, and protocol before requesting
wallet approval. Missing configuration, stale orders, unsupported chains, upstream failures,
and absent wallet capabilities must produce truthful unavailable states. Never substitute
fixtures for live assets or treat request acceptance as confirmed settlement. Implement and
test with isolated mocks or approved test chains; do not execute real-value transactions,
listings, offers, signatures, or cancellations as implementation validation.

Stage 2 NO-HIL capability remains the cumulative scope incorporated by #110. Preserve its
A1–A10 capabilities, A0–A6 acceptance, authority separation, deterministic policy, RWA grounding,
key safety, autonomous recovery, and partner neutrality. Do not retroactively require full
Stage 2 operation or soak evidence for an otherwise independent Stage 1 delivery.

Keep infrastructure and registry partners neutral and pluggable. CCHS and OpenSea are the
client-specified business and marketplace references, not architectural privileges. Deployment bindings are configuration, not product identity.
Backend/database and public-chain execution zones remain distinct.
`<LLM_PROVIDER_A>` is replaceable; model output is advisory and never transaction authority.

## 5. Hard safety and data boundaries

- No private keys, seed phrases, credentials, database dumps, or raw signed transactions in
  ArtFi web/API storage, databases, GitHub, CI, logs, or other prohibited surfaces. Use only
  approved secret-handling and signing paths; never log or publish sensitive values.
- Mainnet, real assets, and real-money operation require the applicable written authority.
  Passing tests or audits does not supply that authority.
- The current write-testing chain is Hoodi `560048`; it does not select the production chain.
- Isolated Hoodi assets are TEST_ONLY. Real CCHS/ArtCCH documents are not prerequisites for
  their technical testing. Keep those fixtures separate from real donation, receipt,
  valuation, holder-benefit, production, and mainnet records.
- Preserve immutable historical mint evidence, including the distinct Sepolia records.
- Protect charity masters, enforce CH.7 and CH.11 preview restrictions, and release only the
  authorized distinct watermarked holder file after wallet ownership verification.
- External-source names and infrastructure bindings follow the established neutrality policy.
- LLM output is advisory. User, operational, and constitutional authorities remain distinct.
  No operational agent infers higher authority from lower authority.

## Development checks

Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branch, review and CI requirements.
Keep changes bounded and preserve compatible code, tests and security fixes.
Run the applicable tests and integration checks for the exact changed source;
record failed and unrun checks separately. Fixtures must remain visibly distinct
from live product data. A build, screenshot or health response alone does not prove
an end-to-end workflow or deployment acceptance.

Configure complete public URLs, including scheme, domain, port and entry path.
Port allocations belong to deployment configuration. Preserve existing listeners,
wallet origins and recovery journals during upgrades.

Use the [installation-asset publication policy](docs/INSTALLATION-ASSET-PUBLICATION.md)
for product artifacts and retain their source identities, checksums and notices.

## Product licensing

[LICENSE](LICENSE) identifies the restricted original-material scope and
applicable exceptions. Solidity and separately licensed dependencies, fonts,
and standard/Kit material retain their own terms. Authorized copies of covered
material require the source attribution described in LICENSE; attribution alone
grants no copying permission. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
