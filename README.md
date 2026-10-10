# ArtCCH ArtFi

ArtCCH:ArtFi is a commercial digital art and Real-World Asset application built on an existing
RWA, vault, fractional trading, and DAO product. The requested delivery destination for its
three distinct sections is [io.artcch.com](https://io.artcch.com).

This repository contains the ArtFi application. It consumes ERC-8415 capabilities through Oracle
and does not implement the separate ERC8415-Kit, Oracle, or independent wallet product.

## Install the reusable delivery

Use the precompiled Linux package and its checksum; production installation does
not require npm, Go, Solidity compilation, or assembling source code onsite.
[Installation](docs/INSTALLATION.md) covers configuration, database migrations,
service templates, verification, upgrade and application rollback. The artifact
also includes optional bounded-runtime and monitoring services, MySQL recovery
tools, and source-bound contract ABI/bytecode. External service and deployment
bindings remain private operator inputs.

[Artifact-first acceptance](docs/INSTALLABLE_ACCEPTANCE.md) runs from the package
itself against fresh isolated MySQL, with optional desktop/mobile browser checks.
[Candidate status](docs/DELIVERY_CANDIDATE_2026-10-06.md) distinguishes verified
features, synthetic evidence and incomplete capabilities. Installing or testing a
package does not authorize contract deployment or a real-value operation.

## Three product sections

### 1 Digital NFTs and CCHS

Digital NFTs have no physical-asset backing. This section connects to
[CCHS](https://cchsc.ca) and preserves the existing charity-edition business and holder-access
workflow. OpenSea is the primary marketplace, not the exclusive marketplace.

The existing charity editions grant only wallet-verified access to the specified high-resolution
watermarked copy. They convey no physical title, possession, redemption, copyright, commercial-use,
or reproduction right. CCHS donation records do not turn the NFT into a physical-artwork receipt.
Charity editions remain independent of the ERC-8415 RWA model.

ArtFi provides edition information, rights disclosures, and a native OpenSea-backed NFT experience:
browsing, listing, buying, offers, eligible cancellation, and result tracking remain inside ArtFi.
Official venue APIs and protocols support the flow; users confirm wallet actions. A redirect,
iframe, or read-only catalog does not satisfy it. The optional external OpenSea link belongs in
the footer. Public charity metadata does not expose artwork previews
or masters, and ArtFi does not issue donation receipts or promise tax credits.

### 2 Whole artwork RWA receipts

A whole-artwork token is a delivery voucher or warehouse receipt for an identified artwork under
its custody and registry record. ArtFi is an ERC-8415 standard commercial application for this
receipt model.

```text
Artwork -> custody and registry record -> ERC-8415 receipt -> applicable market and lifecycle workflow
```

ArtFi preserves the distinction between the token's blockchain state and the registry-confirmed
holder and asset state. A chain transfer alone is not proof that registry transfer or physical
delivery has completed. ArtFi's database is a projection, not an authority over rights.

The section retains its applicable ArtFi signed-trading and external-market integration scope.
The NFT section's venue preference does not reduce the RWA application to external mirroring.

### 3 Fractional trading and DAO

Fractionalization and DAO are inherited from the original PRD and MVP. The section preserves and
completes NFT selection, exact-token approval, vault deposit, ERC-20 issuance, fractional holdings,
buying and selling, history, and the governance defined by the asset structure.

```text
Asset -> vault or asset-specific fund -> fractions or participation tokens -> trading and DAO
```

Token possession does not automatically confer unspecified governance or physical-asset rights.
Every underlying RWA retains the Stage 1 requirement for approved-source, machine-verifiable
correspondence evidence before minting or activation, whether backed by registry, custody,
warehouse, certificate, or other approved evidence. Applicable ERC-8415 identity, restriction,
and lifecycle requirements remain in force, with registry synchronization for registry-backed assets. This section is not given a
blanket ERC-8415 exemption, and its delivery does not require completion of every independent
wallet or infrastructure product.

## Application architecture

```text
ERC-8415 standard
  -> ERC8415-Kit
  -> Oracle
  -> ArtFi application
```

ArtFi integrates with approved, replaceable sources and application-side wallet interfaces.
A registry or infrastructure provider gains no universal authority or privileged marketplace
path because it is integrated. ArtCCH's own-account listings follow the same settlement and
matching rules as other participants.

For registry-backed assets:

- The registry of record establishes recorded holdership within its approved scope.
- The chain establishes token balances, contract state, and settlement.
- ArtFi read models report and reconcile those records without replacing them.

## Functional scope

| Module | Scope                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | Existing asset and vault contracts, auctions, distribution, governance, multisignature controls, deployment tooling, and contract tests |
| M2     | Authentication, wallet binding, signed orders, matching, settlement integration, positions, history, APIs, and audited administration   |
| M3     | Discovery, trading, personal center, governance, charity workflows, and responsive multilingual UI                                      |
| M4     | Asset-specific voting power, proposal lifecycle, timelock execution, and administration                                                 |
| M5     | Security review, penetration testing, remediation, audit evidence, and secret/key protection                                            |
| M6     | CI/CD, deployment, monitoring, backup/restore, operational tooling, and handover documentation                                          |
| CH     | Existing charity-edition rules and protected holder-file access                                                                         |
| XM     | External marketplace adapters, native OpenSea-backed NFT operations, attributed data, and result reconciliation                         |

ArtFi records signed intent and finds counterparties; the chain enforces authorized settlement.
Fixed-price and order-book assets remain in their owners' wallets until atomic fill. Existing
auction escrow is limited to its accepted auction terms and retains safe settlement, withdrawal,
and cancellation behavior. Platform administration cannot move or reassign user property.

Passive external-event ingestion stays read-only while the native NFT frontend orchestrates
user-approved venue operations. Preserve ArtFi's own RWA and fractional trading. Keep fixture
data distinct from real observations and display source, time, freshness, and chain. Missing
venue credentials, supported-chain configuration, or wallet capabilities fail closed and do not
establish that trading has been delivered.

Xiongan Wallet is the V2 tenant of 8415 Wallet, assigned to `xiongan.8415wallet.com`. ArtFi reads
its complete deployment URL at runtime without hardcoded destinations or ports. Test navigation
may open without login; wallet assets, balances, holdings, and history require login.

## Working delivery and production

Delivery is measured by a user completing the applicable workflow through the ArtFi UI, on
desktop and mobile, with current evidence. Code, a contract deployment, a test, or a static page
alone is not a stage handover.

The requested application destination is [io.artcch.com](https://io.artcch.com). Application
deployment, test-chain verification, business opening, final production acceptance, and mainnet
operation are distinct. The domain does not itself authorize real-asset or real-money operations.

- Development and integration write-testing use Hoodi, chain ID `560048`, with isolated TEST_ONLY assets.
- Historical Sepolia charity records remain immutable and are not migrated or re-minted for tests.
- Real charity release evidence does not block the isolated Hoodi technical path.
- A pending visual redesign, later-stage work, or full independent-wallet completion does not
  block an otherwise independent working stage.
- Applicable production audit, mainnet, 48-hour stability, and final operator-handover requirements
  retain their final-stage placement and applicable authorization.
- Stage 2 NO-HIL autonomous operation remains cumulative scope, with its own bounded-authority,
  evidence, recovery, and continuous-operation acceptance. Stage 1 delivery does not claim Stage 2 completion.

For actual completion, test results, deployment evidence, and remaining work, use
[`docs/STATUS.md`](docs/STATUS.md). This README does not promote a requirement or claim that an
unverified workflow is delivered.

## Repository structure

```text
apps/
  web/                 Next.js application
  api/                 API service
  market-mirror/       External marketplace integration
  wallet-extension/    Existing wallet extension alpha

packages/
  contracts/           Solidity contracts
  api-client/          Generated API client

docs/                  Product, architecture, evidence, and delivery documents
```

The wallet-extension directory is existing implementation. Its presence does not make the
entire independent wallet product a prerequisite for ArtFi handover.

## Primary documents

| Document                         | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| [PRD](docs/PRD.md)               | Coordinated product definition and functional requirements |
| [Acceptance](docs/ACCEPTANCE.md) | Applicable evidence and promotion rules                    |
| [Status](docs/STATUS.md)         | Requirement state and current verification evidence        |
| [Agent instructions](AGENTS.md)  | Execution boundaries and scope control                     |

[Issue #110](https://github.com/GiraffeTechnology/ArtFi/issues/110) incorporates the inherited
[#84 baseline](https://github.com/GiraffeTechnology/ArtFi/issues/84). Explicit later client
instructions amend the affected provisions. Historical records do not override the latest
product definition or create new delivery prerequisites.

## Scope boundaries

ArtFi supplies the commercial application and user workflows. It does not become the protocol
implementation, Oracle infrastructure, independent wallet, registry of record, legal title
adjudication system, or replacement custodian. Native mobile apps, fiat on/off-ramp, automatic
debit, forced liquidation, and real buyout settlement remain outside the current scope described
in the PRD.

## Disclosed patent filing references

| Subject                                       | Application number | Related area                |
| --------------------------------------------- | ------------------ | --------------------------- |
| Unattended issuance of off-chain source facts | `202611389399.6`   | Oracle                      |
| Credential mapping from off-chain registries  | `202611389374.6`   | Registry credential mapping |

These are filing references retained from the repository. Filing does not establish patent
grant, production acceptance, or commercial deployment.

## License

This repository is publicly viewable for investor and technical review. Public
visibility does not itself grant permission to use the material covered by
[LICENSE](LICENSE). Applicable GitHub viewing and forking rights are preserved.

Use, copying, modification, distribution, and deployment of material covered
by [LICENSE](LICENSE) require separate written permission, subject to its
stated exceptions. Authorized copies must identify ArtFi, this repository,
and their source version and retain the required notices. Attribution alone
does not grant permission.

Separately licensed components retain their own terms. See
[NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
