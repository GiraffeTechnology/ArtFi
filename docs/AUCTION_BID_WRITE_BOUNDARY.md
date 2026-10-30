# Auction bid write boundary

Auction bid validation now runs inside the existing transaction callback, after its authenticated-session check, for both an exact payment approval and the subsequent bid. A confirmed approval does not preserve authority over old auction terms. The original reviewed listing, exact bidder, amount, approved-source identity, balance and cumulative pilot cap remain binding.

The fill callback simulates its unchanged bid and then checks current terms again before wallet forwarding. A new bid, extension, pause, expiry, insufficient funds, changed chain or reorganized block stops the callback. Only an actual successful contract receipt records settlement; the original pending/UNKNOWN journal and reconciliation remain.

Bid reads require bounded integer balance/cap/usage and an exact boolean permission. A mined block number, full hash and safe timestamp are required; final canonical number/hash/time and chain are rechecked. A finite twelve-second deadline retires the read result without claiming provider cancellation or rollback of an already confirmed approval.

This is scoped client preflight protection. Atomic auction contract rules remain authoritative. Synthetic RPC/unit or browser-fixture results do not establish real signing, deployed-contract or full-product acceptance.
