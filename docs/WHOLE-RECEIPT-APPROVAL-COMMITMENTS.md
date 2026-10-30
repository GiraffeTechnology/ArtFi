# Whole-receipt approval content commitments

This application-owned source contract supplies the two content commitments already accepted as opaque phase fields by Wallet. It uses the existing `nftTaskJournalDigest` canonical JSON/SHA-256 implementation. It does not change Wallet's task digest, native-operation derivation, capability/request digest, typed segment authorization or source authority.

## Input before approval

`projectWholeReceiptApprovalBusiness` validates exactly:

- `kind`: `transaction`.
- `chainId`: an existing supported receipt chain.
- `request.account`: the exact intended phase actor.
- `wholeReceipt`: schema version, phase, segment ID, chain/domain/escrow, every sale field, all eight correspondence fields and the registered phase's Kit version/proof hash.

The validator shares the existing full-plan schema and segment-authorization checks. It rejects unknown fields, getters, malformed values, mismatched domains, a funded phase whose actor differs from the buyer and incorrect registered-proof placement. It accepts no fabricated principal or transport ID. The existing full-plan validator still validates and retains `id`, `operationId` and all task-principal fields; its native operation ID remains derived from the complete principal binding.

Installation supplies exactly `tenant`, canonical `origin`, `taskId`, `actor`, `escrow` and `runtimeCodeHash`. The actor and escrow must match the validated business request/domain. Never source this binding from browser JSON, an Oracle response or a previous digest result. No environment default, registry, network endpoint, account or credential is created by this module.

Addresses and bytes32 content are normalized to lowercase as in Wallet's frozen receipt policy. Canonical decimal strings remain strings; the existing safe uint48 date values remain numbers. This normalization applies to the detached business commitment. It does not rewrite the original postgrant native plan or its wire digest.

## Exact domain records

The business digest is `0x` followed by the existing canonical SHA-256 of:

```text
{
  schema: "artfi-whole-receipt-business-plan/1",
  business: <the complete normalized business object above>
}
```

The journal association hash is `0x` followed by the same existing canonical SHA-256 of exactly:

```text
{
  schema: "artfi-whole-receipt-journal-binding/1",
  tenant,
  origin,
  taskId,
  actor,
  phase,
  escrow,
  runtimeCodeHash,
  segmentId,
  businessDigest: <the business digest above>
}
```

Property order is governed by the existing sorted-key canonical encoder. Every business field is committed, including chain ID, all sale/correspondence fields and any required registered proof. Chain is retained in the business digest; it is not substituted by an unbound chain label.

Both namespace versions are application content formats. They must be pinned with the actual source candidate when a deployment installs this producer and consumer. Historical arbitrary slot literals are not silently migrated, reinterpreted or grandfathered.

Neither record contains `taskDigest`, `grantReference`, grant-derived native IDs, postgrant executor identity or the full native plan hash. Those values do not exist at pregrant approval time and remain mandatory independent postgrant checks. Phase nonce, calldata, gas and fee ceilings remain in Wallet's actual frozen phase slot and authorization checks; this content producer does not replace or relax them.

## After the real grant

`assertWholeReceiptApprovalPlan` validates the entire actual native plan and recomputes both content records. It checks task identity and compares the two exact lowercase prefixed digests supplied by the current genuine held runtime. It retains the full native plan and principal in its result.

Do not compare the prefixed business digest directly with the native journal's bare-hex full-plan digest. A new grant can bind identical business content while having a different native operation identity. Matching content does not permit another grant to recover or mutate a prior grant's journal row.

Every result explicitly carries `authorization: "NOT_ESTABLISHED"`. This module opens no grant gate, capability, journal, nonce reservation, provider request, signature or send. Hash equality does not verify the underlying segment signature, authenticate an Oracle/registry/custodian, prove a deployed code hash or authorize payment.

## Remaining integration

The typed Go claim decoder remains in place and the existing receipt consumer/store remain fail-closed until actual installation-owned business/source/asset/segment/journal binding is composed. Merely adding this producer does not enable receipt execution or fall back to NFT listing authority. Actual Wallet single-gate held context, genuine mTLS peer identity, durable one-use consume/CAS, revocation/TTL, only-forward recovery, unknown-outcome reconciliation and reorg boundaries remain required.

The focused regression source is `whole-receipt-commitments.test.ts`. It covers each phase, every sale/correspondence family, proof and domain changes, installation association, canonical hex case, snapshot isolation, pregrant/postgrant separation and principal/native-ID substitution. Authored cases are NOT_RUN until actual Linux evidence records their exact source and command. Existing tests on earlier heads do not certify this source. Full integration, runtime and final delivery remain incomplete.
