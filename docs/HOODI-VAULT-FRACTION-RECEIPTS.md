# Vault and fraction receipt verification: development scope

This additive read-only verifier observes completed ERC-721 Vault creation,
custody and fixed-supply fractionalization. It supplements the separate digital
edition verifier, whose ERC-1155 atomic batch checks do not cover these contracts.
It reuses the existing dependency/runtime without changing contract, governance,
authentication, installation or wallet implementation.

Checks cover event identity and order, factory mappings, continuing custody,
Vault/token associations, supply, configured role contracts, canonical finalized
receipts, block-hash state reads and final observation consistency. Initial mint
delivery remains visible even if the recipient subsequently transfers fractions.
Missing inputs produce NOT_RUN. Unsupported or conflicting observations do not
trigger a fallback, replay, signature or transaction.

Verification proves only the observed receipt/state relationship. It does not
establish source authenticity, registry holdership, Safe quorum or exclusive-role
policy, wallet authorization, image provenance, metadata contents, UI acceptance
or whole-product completion. Exact runtime provenance and the original read
provider still require independent validation. Operational bindings, inputs and
execution evidence remain in the existing controlled private workflow.

The 24 authored synthetic Node fixture cases have not been executed by the
initial author. The assigned validation owner runs:

```sh
node --test scripts/test/hoodi-vault-fraction-receipts.test.mjs
```

Fixtures are artificial RPC responses, not EVM execution or real chain evidence.
Actual combined-runtime verification and post-submission changes belong to the
assigned validation owner. Earlier native packaging increments do not
automatically include this new verifier.
