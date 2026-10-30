# Filters and pages for loaded private portfolio history

The authenticated portfolio history now has event and status filters, ascending
or descending block/log order, ten-record local pages and reset controls. The
screen states that these controls apply only to the indexed response already
loaded. It does not claim all-time wallet history or server cursor pagination.
Refresh remains the parent portfolio refresh action.

All controls remain inside the existing authenticated, wallet/session-keyed
portfolio subtree. Logout, expiry or account changes retain its existing
unmount/reset boundary. Filter state is component-local; it is not stored in
local storage, URLs or a cross-wallet cache. No new network request, endpoint,
deployment parameter or trading authority is introduced.

Rows retain complete transaction and contract identifiers, block/log positions
and observation timestamps. Removed logs explicitly supersede previous
confirmation. The projector validates record shape and unique event identity,
rejecting malformed history instead of silently displaying a partial list.
An empty authenticated result and an empty filtered result are distinct.
Page bounds are clamped when refreshed data shrinks. Source arrays are not
mutated. Token positions, P&L and notification rendering are unchanged.

The two new focused test files contain authored projection and static-render
regressions. Their presence is not a test result; ordinary execution, browser
interaction, mobile layout, accessibility and acceptance remain independent
validation work against the submitted source identity.
