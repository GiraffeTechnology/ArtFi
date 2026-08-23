# ArtCCH:ArtFi RWA DAO governance and rights validation

This policy describes the testnet implementation boundary. Base Sepolia is the primary validation
chain and Ethereum Sepolia remains a compatibility baseline. It is not a production launch,
securities-law opinion, title opinion, or authorization to use real assets or funds.

UNIT-A02 is authorized only in the isolated Base Sepolia namespace documented in
`A02_BASE_SEPOLIA_DAO_TEST.md`. Its 100 test NFTs, vaulted representative and paired governance
units must never enter the formal 37-artwork charity set, a production manifest or any mainnet.

## Authority model

- Each Governor is bound to exactly one `ArtFiVault`, its fixed-supply `FractionalToken`, one
  Timelock, and one `ArtFiDAOActions` registry.
- The Vault must have deposited the configured ERC-721 and remain its on-chain owner. A DAO cannot
  silently switch to an unrelated token or asset.
- ArtCCH has no Governor vote, proposer override, Timelock administrator, or unilateral execution
  role. Holders govern; ArtCCH may assist with physical matters only after an approved request.

## Rights validation

1. The UI asks the connected wallet for a domain-separated, one-time nonce signature and verifies
   it locally. The signature is not persisted; the transaction signature remains the final proof
   of control for each write.
2. A positive current fractional-token balance and a valid Vault custody check establish DAO
   membership for the connected wallet.
3. Proposal rights use `getPastVotes` at the Governor snapshot. The threshold is fixed at the
   ceiling of 10% of total issued supply. Holders must delegate, including self-delegation, before
   the snapshot.
4. Vote weight is historical snapshot weight. Transfers after the snapshot cannot create a second
   vote or move the same voting power between accounts for that proposal.

On-chain possession does not prove physical title, copyright, beneficial ownership, residency,
accredited-investor status, or exemption eligibility. Those are separate fail-closed legal and
operational gates.

## Classified decisions

Proposal calldata is restricted to one action registry and its selector must match the declared
proposal kind. Success is measured against total token supply at the proposal snapshot, not merely
votes cast:

- market migration: strictly more than 50%;
- warehouse transfer, auction, sale, custodian change, or evidence-bound shared-failure assessment:
  strictly more than 66.6667%;
- forced-buyout initiation: strictly more than 80%.

## Evidence and deferred enforcement

Every executable action includes an evidence URI and cryptographic evidence hash. Forced-buyout
terms require an independent verifier for the applicable `T0..T-30` volume-weighted price or, if
there were no trades in that period, the latest 10 actual trades. Missing or rejected evidence
reverts execution.

The action registry records approved intent; it does not itself move a physical work, debit a
holder, transfer tokens, or settle a buyout. Automated cost collection, forced closeout, escrow,
notices, grace periods, disputes and production settlement require detailed rules, BC legal review,
consumer/investor safeguards, a new security audit and a separate go-live approval.
