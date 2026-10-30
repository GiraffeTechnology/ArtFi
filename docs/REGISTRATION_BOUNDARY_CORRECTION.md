# Registry-backed receipt correction: partial implementation

## Scope and authority

This implements part of the client's 2026-10-16 instruction to correct the existing ArtFi
registration semantics under #110 and the clarified PRD section 1.2. It is not completion of
the receipt lifecycle or production acceptance. Base: `5e7cc4cd482be71431d904439ef79d1ab5d7eade`.

## Defect and implemented boundary

`WholeArtworkMarket.fillIntent` transfers a new ERC-20 payment from the buyer, transfers the
ERC-721 owner, and emits `SaleSettled`. It does not inspect an Oracle registration record or
release a previously frozen wallet balance. Its legacy whole-artwork UI presented this as
settlement and labeled `ownerOf` as holder.

The current catalog already distinguishes registry-backed sources: Go verifies the approved
source and signed registry reference, then derives `grounding.registryBacked` from the admitted
registry record (`rwa_grounding.go`). The application correction reuses this existing identity:

- Current catalog reads remain exact-bound to section, chain, collection, token and market.
  Reviewed identity now includes registry classification and the registry reference/version.
- Whole registry receipts cannot use the legacy signature, market-approval, fresh-payment or
  fill route. Each existing new-action grounding read checks that classification; payment and
  fill recheck separately. A contradictory false flag accompanied by a registry record cannot
  downgrade the asset. No owner/holder equality rule or second offline receipt is introduced.
- Native order publication rechecks the real server catalog before signature admission. Missing,
  ambiguous, inactive or misbound current records do not fall back to the legacy payment path.
- Read-only catalog/history, old transaction reconciliation and authorization withdrawal remain.
  Non-registry whole assets retain their current direct-payment path. Charity and fractional
  contracts and workflows are unchanged.
- UI labels distinguish token owner from registered holder. Historical legacy transaction
  confirmation does not claim registry registration or frozen-funds release.

The `registryBacked` component prop is a display hint only. It cannot authorize an action:
current catalog revalidation is still mandatory. Oracle's existing projection remains read-only;
its HTTP source assertion is not promoted to an independently verified on-chain execution proof.

## Remaining contract boundary

The deployed legacy contract has no trusted registry classification or frozen-balance adapter.
Direct contract calls can bypass application guards. This change does not change, revoke,
pause or upgrade any deployment or previously signed authorization, and cannot establish full
on-chain enforcement. No fictional classification flag is added to that contract.

A correct executable registry path still needs exact integration with the existing authoritative
interfaces. These are engineering gaps, not new client approval gates:

1. Mint-bound deadline/receipt-format terms and an authenticated Oracle chain registration
   record must bind the same asset, trade occurrence and current valid holder.
2. The wallet reservation and release must support the configured payment asset. Native-only
   reservations cannot silently replace ArtFi's existing ERC-20 terms.
3. A deadline failure must bind rollback to the current valid holder and unresolved suffix,
   preserve completed registrations and settled prefix, and permit a new trade when owner equals
   holder and the NFT is not burned. Retry/recovery must preserve operation identity and history.
4. The final integration must enforce these conditions on chain, including direct calls. HTTP
   catalog admission and a token-transfer receipt are insufficient substitutes.

## Existing integration seams, not invented APIs

- Oracle main `27217e65a6e71baaeff5d7c53a2c8de126e5b69d` already admits holder and receipt
  commitment together in `OracleRegisterProjection.appendFromSource`. ArtFi must consume that
  authorized record; settlement/fund release does not require a new Oracle settlement API.
- Wallet main `de79227f0b886d86d674a70d67d5608576c8156c` has native-currency reservation,
  forwarding, admission binding, prefix completion/allocation/withdrawal and bounded return
  controls. Those controlled-wallet interfaces require compatible token settlement capabilities
  and do not themselves impose ArtFi's mint-deadline/current-holder policy. The reference
  composite is not proof of a production-compatible ArtFi ERC-20 deployment.
- Unmerged Wallet PR #99 at `80f4272ef040750f2f4ad2235f9b1ae1b5bd1af1` already supplies the
  ArtFi receipt ABI phases `fund`, `confirmRegistration`, `paySeller`. ArtFi open PR #177 and
  stacked #198/#199/#200 add typed capability and held-journal composition boundaries. They are
  preserved. Their registration proof is an on-chain/Kit binding, not by itself a second offline
  receipt. Their existence does not establish a deployed or accepted end-to-end receipt path.

No Oracle, Wallet, Kit, workflow, credential, permission, deployment or real-value transaction
was changed by this correction.

## Verification

See the dated `docs/STATUS.md` entry for exact local checks and the draft PR's exact-head CI.
The authored tests cover registry classification, source identity changes, bypass attempts,
server admission, owner labels, preserved non-registry approval and withdrawal controls.
Synthetic tests do not establish live Oracle/Wallet integration or chain settlement acceptance.
