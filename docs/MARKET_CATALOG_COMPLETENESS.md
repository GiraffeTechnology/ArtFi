# Complete bounded mirror catalog scans

The information-mirror catalog publishes rows only after validating every page in its existing bounded scan. The reader checks the current API schema, source, runtime marker, requested page and size, safe total, exact remaining page length and unique chain/contract/token identities. Malformed runtime rows, changing totals, duplicate identities, oversized catalogs, cancellation and failed later pages do not become a successful partial inventory.

The existing limit is 100 pages of 100 records. A larger catalog now gives an explicit unavailable state rather than presenting a truncated 10,000-row prefix as the full catalog. Supporting larger catalogs requires server-side filtered/keyset access; this change does not invent that API. Refresh requests omit credentials, reject redirects, retain the configured API URL, and are cancelled on component cleanup or after a bounded timeout.

This endpoint uses offset pages without a snapshot identifier. Equal counts and unique rows cannot establish an atomic database or chain snapshot, so the UI describes a completed observation scan. Observed listings are not current trade eligibility, custody, ownership or financial authority. Existing source-link checks and raw price units remain unchanged.

Focused tests use synthetic API envelopes. They establish reader invariants, not actual upstream availability or full runtime acceptance. Run applicable verification only on an existing approved remote Linux server.
