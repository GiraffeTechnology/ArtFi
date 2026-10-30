# Application moderation, appeals and configuration

## Product trace and authority

This implements the existing admin APIs in PRD §4.2 and administrative console
in §4.3. The bounded application workflow is content-report triage, documented
content warnings, private appeals, a platform service notice, and durable audit
history. It does not modify asset ownership, balances, signed intents, orders,
settlement, registry records, fees, seller priority, custody or chain permissions.
The same content-review rules apply to own-account and third-party activity.

- `/support`: public content notices; authenticated private report creation,
  owned-case history, decision and appeal submission.
- `/admin`: permission-checked queue, review/decision forms, appeal outcomes,
  platform service-notice configuration and read-only audit history.
- Tools navigation exposes both pages on desktop and mobile.

A content warning identifies a reported content reference and publishes only the
moderator-authored notice. It is advisory content moderation, not a takedown,
transaction cancellation, asset freeze, ownership determination or legal decision.
The public notices page is the authoritative application view of these warnings.
No warning silently blocks a seller or changes the settlement path.

## Deployment

Apply migration `000012_moderation_admin` after the existing migrations. Configure
MySQL and the existing durable wallet-session service. Set `ARTFI_ADMIN_WALLETS`
on the Go API to the comma-separated wallet addresses assigned the application
moderation role. This setting is optional in the installer; empty means no admin
wallet has access. An invalid entry disables the entire configured role. Restart
the API after changing this deployment setting.

Users and administrators sign in using the existing wallet-signature session.
The server checks session revocation and expiry on every protected request. Each
browser request is additionally bound to the displayed wallet and chain. The
server-only operator credential and `REGISTRAR_ROLE` do not grant this role.
The web console cannot modify its own permissions, security configuration,
credentials, trading settings, or chain roles.

The only mutable platform configuration is the plain-text service notice. A
published notice is displayed throughout the web application on page load,
visibility refresh, and every 60 seconds. An unpublished draft is visible only
through the admin endpoint. Integration outages do not expose an unpublished
notice or invent a successful configuration update.

## State and recovery

1. An authenticated user submits a reference, category and explanation. The
   durable case belongs to that wallet; a supplied owner field is not accepted.
2. A moderator can move an open case into review or resolve it directly with
   `no_action` or `content_warning`. Every transition requires a reason and the
   current revision. Publishing a warning requires a separate public notice.
3. The original reporter can appeal a resolved case once. The appeal statement
   is private. The existing outcome remains in effect during review.
4. A moderator can uphold the appeal and replace the content outcome, or reject
   it and preserve the original outcome. Both record a response without erasing
   the earlier report, decision or appeal evidence.

Each mutation requires an actor-scoped `Idempotency-Key`. The request receipt,
revision-locked state and audit insert commit in one MySQL transaction. Repeating
an identical key/payload returns the original receipt without another state
change or audit event. Reusing a key for a different method, path or payload
returns 409. Concurrent stale revisions return 409; the UI requires a refresh
rather than silently applying a decision to newer state. An uncertain request
can be retried with its same key. Database or audit failure rolls back the whole
mutation. No in-memory success fallback exists.

## Privacy and audit

- Owner routes remain owner-scoped even for admin wallets; another wallet receives
  404 for private case details or appeals. The admin routes explicitly require
  the separate moderation role.
- Public notices contain only the case ID, reported reference, approved public
  notice and timestamp. They never return reporter identity, report details,
  appeal statements or responses. Moderators review both the reference and the
  public text before publishing a warning.
- Private report, appeal, identity and audit containers opt out of automatic
  translation, avoiding transmission of private case content to the translation
  service. Static page instructions retain the normal translation behavior.
- All administration responses use `Cache-Control: no-store`. Logout, wallet or
  session changes unmount the previous private workspace. Permission failures
  clear displayed private records. Free text is rendered as text, never HTML or
  an executable link.
- Successful mutations append to the existing `security_audit_log`, including
  actor, resource ID, previous revision, resulting snapshot, timestamp and request
  ID. The API has no audit edit or delete operation. Migration rollback preserves
  the audit table. Operational database retention/access policies remain the
  responsibility of the deployment; this is not a claim of immutable storage
  against a database administrator.
- The OpenAPI 3.1 contract and generated client include the protected user/admin
  routes and the two public read endpoints.

## Verification

Local checks on the implementation:

- Go unit tests cover disabled/malformed role configuration, operator/indexer
  credential rejection, fail-closed persistence, strict bounded payloads and
  permitted/forbidden moderation transitions.
- Isolated real MySQL tests with `-race` cover report → review → decision → appeal
  → upheld outcome, owner privacy, public-data minimization, restart persistence,
  concurrent idempotency/revision races, forced audit failure and rollback,
  safe retry, service-notice publication/draft privacy and session revocation.
- Frontend tests cover exact wallet/chain binding, CSRF, bounded proxy routes,
  retry-key reuse, errors without upstream secrets, permission gates, escaped
  report rendering and exclusion of private content from translation.
- Installer tests cover the optional admin-wallet configuration and reject
  malformed or zero addresses. Focused lint, web typecheck and OpenAPI client
  generation are part of the local validation.

These checks do not claim live deployment, final aggregate acceptance, real user
reports, production moderation decisions or any blockchain transaction. Final
browser and installer integration evidence belongs to the complete delivery.
