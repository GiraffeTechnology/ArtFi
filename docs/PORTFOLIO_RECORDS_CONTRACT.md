# Rendered indexed portfolio evidence

The portfolio remains an authenticated read model of indexed chain events.
Validation of its response does not establish a wallet's current chain balance,
registry holdership, custody, property rights or financial authority.

The client now decodes the fields it renders before publishing a response into
React state: the matching Hoodi identity, positions, exact integer strings,
canonical event references and statuses, notification text, and FIFO performance
shape and counts. Negative indexed balances remain visible as incomplete history.
Large integer strings and negative realized P&L retain their exact values.
Unknown basis remains unknown, and a missing legacy performance projection is
not replaced with zero. Malformed rows are unavailable rather than a fabricated
successful empty account.

Duplicate assets or event IDs are rejected within each list. History and alerts
use different supported windows, so an alert need not appear in the loaded
history. When both contain the same canonical event, their evidence fields must
agree. Confirmation/removal text follows the existing Go API's three message
forms; a previous confirmation cannot be presented beside contradictory removal
evidence from the same response.

The loader preserves its context-abort guard and clears previous state at the
start of each request. Rendered objects are projected into fresh objects instead
of reusing unvalidated response rows. Unexpected body/transport diagnostics map
to a fixed unavailable message. This layer neither changes the upstream
authentication guard nor replaces required same-version API, database, browser
and deployed acceptance.
