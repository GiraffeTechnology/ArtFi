# DAO creation presentation contract

The existing `POST /v1/vault/intents` and intent lookup/submission responses gain an optional
`presentation` object. It is immutable descriptive creation-request data, not proof of custody,
membership, valuation or rights. Name, symbol, contract calls and role checks retain their existing
meanings. This initial interface uses a configurable monogram avatar, not a remote image fetch.

```json
{"version":1,"description":"Plain descriptive text","avatar":{"text":"DAO","palette":"teal"}}
```

- `version` is exactly 1.
- `description` is at most 2000 UTF-8 bytes. Control characters other than LF are rejected.
- `avatar.text` contains one to three Unicode letters or numbers.
- `avatar.palette` is `teal`, `violet`, `gold`, `rose` or `slate`.
- Unknown profile/avatar fields are refused. No URL, uploaded file, HTML rendering or external
  image request is part of this representation.
- Omission remains valid for legacy clients and saved requests. It is omitted from JSON and remains
  SQL NULL, preserving the original legacy payload hash and deterministic request identity.
- Including a profile binds it into the existing payload hash and request ID. Changing any profile
  field under the same idempotency key conflicts. A frontend must verify the full returned profile
  before continuing the existing wallet workflow. It must not drop fields to make a mismatch pass.

New creation forms include an editable description, monogram text and palette preview. Original
profile-free saved configurations keep the inclusion checkbox off until the user opts in. Profile
editing retires reviewed form terms through the existing change handler. Confirmed/pending
transaction recovery, Safe authority, role simulation and chain receipts retain their controls.

## Persistence and ordering

Migration `000016_dao_presentation` is reserved for this feature. Merge/apply PR174's
`000015_notification_inbox` first and verify the actual database migration ledger. The zero-row
schema reads in 16 fail before its ALTER when required prior columns/table are absent; they are
not proof that the whole prior migration or its trigger has been verified. Never apply 16 early
and later omit 15 because the recorded schema version advanced. If 15 is cancelled or renumbered,
reconcile the migration plan before applying either candidate.

The new nullable JSON column retains legacy rows and is read through the authoritative DB path
and startup hydration. Invalid persisted profiles fail closed. Downgrade refuses destructive
profile-history removal; earlier application code can tolerate the unused nullable column.

## Integration and validation handoff

The primary OpenAPI/generated-schema source is already in the acceptance owner's integration
queue. Its existing VaultIntent input/output schemas need this optional object with the constraints
above and the same 400/422/409 semantics. This document is the exact additive contract input; it does
not claim generated-client or OpenAPI equivalence before that owner integration.

Authored cases cover multilingual byte limits, unknown fields, immutable copies, old payload
bytes, profile idempotency conflicts, two live API service instances, DB restart hydration, legacy
omission, recovery binding and escaped UI rendering. Ordinary tests, migration application,
typecheck/build/browser checks and independent acceptance remain with the designated reviewer.
No fixture or source-presence result is full product acceptance.
