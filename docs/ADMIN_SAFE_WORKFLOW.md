# Multisignature operator creation workflows

## Scope and requirement

This implements the existing multisignature administration requirement in
`docs/PRD.md` section 4.1 (M1.6), inherited by the issue #110 product baseline.
It connects the existing `ArtFiAdminSafe` contract to three existing operator
creation surfaces. It is not a new treasury, arbitrary-call console, custodian,
contract deployment service, or grant of platform authority.

- `/create/rwa`: the existing source-bound `createAssetWithEvidence` call
- `/dao`: the existing `VaultFactory.createVault` call, followed by the existing
  separate NFT approval, deposit and fractionalization steps
- `/create/rwa?standard=erc1155`: the existing fixed charity `createSeries` call

The console only exposes the appropriate creation selector on the configured
section target and always attaches zero ETH value. Network gas remains separate.
It adds no contract entry points or roles. Direct-role deployments remain
compatible when no administration safe is configured or assigned the target role.

## Deployment configuration

Configure both variables to the same nonzero address of the already deployed,
reviewed `ArtFiAdminSafe`, or leave both unset for a direct-role deployment:

- `ARTFI_ADMIN_SAFE_ADDRESS`: server operator-session binding
- `NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS`: public runtime configuration

The public value is runtime supplied through the existing public configuration
bootstrap. No network endpoint or production port is introduced by this feature.
The supported write-test chain remains Hoodi, chain ID `560048`; this is not a
production-chain selection. The server retains its existing SIN execution-zone
and RPC requirements.

The registry and VaultFactory targets still come from the existing deployment
configuration, and the charity target still comes from
`NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS`. The safe must actually hold the
section's existing role on chain:

| Section         | Existing target role                                     |
| --------------- | -------------------------------------------------------- |
| RWA             | `REGISTRAR_ROLE` on the configured registry              |
| Vault creation  | `CREATOR_ROLE` on the configured factory                 |
| Charity edition | `SERIES_CREATOR_ROLE` on the configured edition contract |

Setting an environment variable does not grant a role, install a safe, move any
asset, or authorize a role handoff. Those are separate deployment operations.
No real role transfer or contract deployment was performed for this delivery.

### Existing operator-session boundary

The upload, RWA and Vault operator proxy routes retain their original registrar
session requirement. A safe owner can satisfy it only when the exact
server-configured safe actually holds `REGISTRAR_ROLE` on the exact configured
registry. An arbitrary safe address or target supplied by a caller cannot
establish an operator session. Vault creation also checks the factory's creator
role before proposing and before each safe write.

Consequently, a safe configured only as factory creator does not itself grant
access to the existing registrar-protected upload/Vault API. Use the deployment's
existing registrar authorization; this feature deliberately does not widen those
API permissions.

The signed sign-in challenge and session are bound to wallet, chain, registry
and configured safe. They retain the existing nonce and expiry rules. Deployment
identity changes invalidate prior tokens, and each protected request rechecks
current on-chain authorization. Charity creation retains its existing on-chain
creator authorization without adding an unrelated operator API session.

## Operator sequence

1. Connect the supported wallet network. For RWA and Vault, verify the existing
   operator session. A connected address alone is not login or authorization.
2. Complete the existing creation form and its original prerequisites. RWA
   source correspondence evidence and charity package/no-preview controls are
   preserved.
3. In safe-enabled Vault creation, blank admin and pauser fields use the
   configured role-holding safe. Blank fractionalizer and recipient fields keep
   the connected owner. Explicitly entered addresses and saved requests are
   never silently replaced. The final addresses are shown in the role summary
   and named decoded arguments before a proposal is submitted.
4. When the configured safe holds the target role, form submission prepares an
   unsigned proposal instead of directly calling the target as the owner EOA.
5. In **Multisignature administration**, inspect the chain, safe, target, request
   ID, decoded arguments, exact calldata and calldata hash. Confirm the review
   checkbox and choose **Submit safe proposal**. The wallet confirms the safe
   call. Submitting records the proposing owner's first confirmation.
6. Share the safe address and numeric proposal ID with another owner. That owner
   opens the same section, verifies their own session where required, loads the
   proposal ID, independently reviews its actual chain data, and chooses
   **Confirm as this owner**.
7. Any owner who has confirmed can choose **Revoke my confirmation** before
   execution. If the count falls below threshold, the contract resets readiness;
   reaching threshold again starts its delay again.
8. **Refresh safe status** reads owners, threshold, delay, confirmation count,
   this owner's confirmation, readiness and executed status. Readiness uses
   chain time, never the device clock. The UI does not treat reaching threshold
   as completed execution.
9. Once executable, an owner independently reviews the call and chooses
   **Execute confirmed proposal**. The exact call is simulated and its current
   role/session/owner context is rechecked before the wallet request. The target
   contract's current checks remain authoritative, including time-sensitive
   source evidence.
10. After execution, choose **Recover creation result** to run the section's
    existing confirmation flow. RWA binds the original request and recipient
    separately from the safe that executed the mint. Vault returns to exact-token
    approval, then custody, then issuance. Charity verifies its matching series
    event and fixed supply/recipient balance.

No operation is automatically signed, confirmed by another owner, or executed
when a timer expires.

## Proposal identity and updated call bytes

The safe's outer request ID commits to the original operation ID, target address
and exact calldata hash. The target's inner request ID is unchanged. Retrying an
identical call therefore uses an identical proposal identity. If simulation
returns an existing exact proposal, its chain state is recovered without
requesting another wallet transaction. A renewed RWA
source envelope changes calldata and gets a different safe proposal identity
without changing the underlying mint operation ID.

A renewed call requires a separate proposal and fresh owner confirmations. The
old proposal remains immutable on chain and can still be loaded by ID, even
while a newer call is prepared. **Review newly prepared call** returns to that
new call after inspecting an older proposal. Recent
older IDs are retained in the browser recovery record. Owners may revoke their
old confirmations separately; creating a new proposal never claims to cancel an
old one. RWA evidence must be valid when the actual execution occurs. This
feature does not extend evidence validity or bypass source checks.

## Interrupted work and recovery

The console reuses the existing browser-session setup journal. It stores public
call bindings, proposal IDs, action identity and transaction hashes; it stores
no keys, wallet signatures or signed raw transactions.

- A pending wallet request or broadcast blocks another write in that console.
  Leaving the route, switching wallet, or refreshing does not cancel it.
- A known hash can be checked with **Refresh safe status**.
- If the wallet response was lost before a hash returned, copy the original
  transaction hash from the wallet into **Original wallet transaction hash**.
  The console checks the exact sender, safe, method and arguments before
  accepting the receipt.
- A normal wallet rejection clears the unresolved request for a deliberate
  retry. An uncertain wallet failure does not.
- A proposal ID can be loaded independently on another owner's browser. The
  chain is authoritative; browser records alone cannot confirm or execute it.
- When another owner executed a proposal, refresh its state and enter that
  owner's execution hash in **Execution transaction hash (any owner)**. The
  exact safe execution and event are checked before the creation result is
  recovered.
- Only the original matching RWA/Vault preparation can receive a recovered
  result. Loading someone else's proposal never overwrites the current form's
  request or recipient.

Changing deployment bindings or corrupting/removing recovery storage does not
silently authorize a replacement transaction. Inspect the original wallet and
chain record first. Private operator review data is marked `data-no-translate`.

## Verification and remaining environment inputs

Ordinary isolated coverage is provided by:

- `src/lib/admin-safe.test.ts`
- `src/lib/admin-safe-client.test.ts`
- `src/lib/operator-auth.test.ts`
- `src/lib/rwa-mint-recovery.test.ts`
- the existing setup recovery and runtime configuration tests
- `e2e-safe/admin-safe.spec.ts`, using only synthetic browser wallet/RPC/API
  fixtures on desktop and mobile, with `playwright.safe.config.ts`

Run the isolated browser suite with the repository's approved browser binary
and an available local test port. `ARTFI_SAFE_E2E_BASE_URL` can supply a different
isolated local base URL. Set `ARTFI_E2E_PRODUCTION=1` to test an already built
candidate. No external RPC, wallet signature or real asset is used by that suite.

These are functional implementation checks, not an independent security review
or formal audit. Current exact test results belong in the delivery evidence;
this document does not claim a production deployment or completed real operation.
Live use still requires the deployment's actual reviewed safe/target addresses,
RPC/session configuration and existing role assignments, plus the existing
per-operation evidence and wallet confirmations. No production access,
SSH operation, real signature, real transaction or deployment is part of these
checks.
