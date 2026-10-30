# Principal journal recovery audit

`PrincipalFundsJournal.Audit` checks one existing operation's complete database
history in one repeatable-read, read-only MySQL transaction. It supplements the
paged history view: individually valid JSON records do not prove that their
sequence is possible or that the last event agrees with the current row.

The fixed installer authority must explicitly authorize the `audit` action for
the current caller and complete original binding. No public route, default
authority, signer, financial request or automatic repair is installed. The
audit never calls `ReadPrincipalObservation`, reserves a grant or retries a
payment. Existing grant, expiry, peer and principal boundaries remain applicable.

The first event must be revision 1 with only `prepared` metadata and matching
creation/update times. Every later event must preserve the original binding and
creation time, increment revision by one, respect monotonic processing time,
and pass the original observation state machine. Exact equality with the
calculated next record rejects missing or reordered events, spurious revisions,
unreconciled UNKNOWN results and reopening of settled outcomes. The final event
must equal the current SQL row.

The caller selects a complete-history limit from 1 to 256. A larger operation
returns `PRINCIPAL_JOURNAL_AUDIT_LIMIT`; a partial scan is never reported as a
successful audit. Limits bound both SQL results and application memory. The
repeatable-read snapshot excludes concurrent later changes from this audit.
A failed SQL read or transaction returns no report and performs no retry.

The report contains only operation ID, revision, event count and processing
timestamps. It does not export the complete principal, financial references or
source proof. A successful report means database-history consistency only.
It does not revalidate historical Wallet results, canonical source finality,
current grants or property authority. An existing immutable financial result
still needs its actual approved Wallet/source reconciliation when applicable.

Authored checks include synthetic corrupt histories, explicit audit authority
and bounds, and an isolated MySQL case whose middle event is canonical and
individually valid but creates an impossible terminal-to-pending sequence. The
SQL case also checks that the read-only audit leaves both corrupted evidence and
the current row unchanged. It uses the existing isolated integration fixture and
migration 000017; it does not touch deployed data or restart the database.

The implementation source was formatted through the existing Linux gofmt using
stdin, with exit 0 and independently matched output SHA-256. Test-source
formatting was not executed. Go compilation, unit and MySQL execution remain
unverified. Run the affected checks on the approved existing Linux/isolated MySQL
environment, setting `ARTFI_PRINCIPAL_JOURNAL_MYSQL_REQUIRED=1` for the required
database run. Actual restore/restart, concurrent-writer snapshot fault injection,
real adapter/bootstrap and independent recovery acceptance remain open.
