# DAO platform-session boundary

Public proposal discovery, aggregate votes, configured rules and unsigned draft
preparation remain public. Personal token balance, delegated voting power and
ownership percentage require the current wallet-bound ArtFi session. Disabled
queries are insufficient because a query cache may still hold an earlier value;
the rendered account metrics also hide those values after logout or expiry.
Unavailable reads are distinguished from a successful zero balance.

The governance panel's ownership-message signature proves control of an address.
It does not replace platform sign-in. Both that prompt and every delegation,
proposal, vote, queue and execution request now use the existing platform-session
check. Before a transaction prompt the panel verifies the reader chain and
simulates the exact contract request, then checks the session again. A changed
wallet, authentication revision, action lease or unmounted view prevents a new
wallet request. Existing on-chain membership, snapshot voting, proposal classes,
thresholds and timelock checks remain authoritative.

Authentication changes retire the private view, while the durable DAO operation
key remains bound to the original wallet and deployment. A transaction hash
returned after navigation still reaches the original recovery state. Logout does
not pretend to undo an already submitted transaction or clear UNKNOWN outcomes.
No signer, grant, automatic debit or buyout-settlement capability is introduced.

Synthetic controller/guard checks and actual React static rendering can verify
these source boundaries. They do not establish mounted-browser cookies, live RPC,
membership transactions, DAO execution or complete product acceptance.
