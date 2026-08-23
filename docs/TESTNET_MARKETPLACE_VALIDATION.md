# Base Sepolia and OpenSea validation strategy

This strategy produces pre-mainnet test evidence only. Base Sepolia (`84532`) is the primary write
target; Ethereum Sepolia evidence is a compatibility baseline and cannot substitute for this run.
No mainnet, bridge, swap, real-value settlement or ArtFi-operated exchange action is authorized.

Named roles:

- `ArtFi1`: `0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089` — issuer and initial holder.
- `ArtFi2`: `0xDE3c1D455c2CCe1bAcf1e70aAC7fA3B8cCb1ec2B` — buyer and DAO participant.

Private keys and key-file paths never enter the repository, servers, CI, RPC requests or evidence.
All public-chain activity originates from the approved non-sandbox Windows host through the fixed
SIN bridge. ArtFi is the only broadcaster and nonce coordinator.

## Track A — formal 37-artwork batch

1. Pin the release commit, Base Sepolia chain identity, compiler/optimizer, ArtFi1, creation and
   runtime bytecode hashes, the 37-series manifest, metadata bytes and English inscription digest.
2. Deploy `ArtFiCharityEditions`, simulate the atomic `createSeriesBatch`, sign locally, broadcast
   through SIN, and record receipts. UNIT-A02 must revert and must not have formal metadata.
3. Verify 37 token IDs, 100 units each, total supply 3,700, ArtFi1 balances, events, URIs, metadata
   hashes, ERC-165/ERC-1155 interfaces, pause/role boundaries, duplicate rejection and no later mint.
4. Record deployment, batch and approval gas including the Base L1-data component. A production
   estimate above the separate budget gate cannot be inferred from testnet success.

## Track B — isolated UNIT-A02 RWA/DAO

Deploy only the contracts and metadata under `ARTFI/BASE-SEPOLIA/A02/RWA-DAO/V1`. Mint exactly 100
test ERC-1155 units to ArtFi1, vault the single RWA representative, and issue exactly 100 governance
units. Transfer paired NFT/governance units to ArtFi2 and reconcile both balances. Validate 9% cannot
propose, 10% can propose, 51% passes market migration, 67% passes a physical-action request and 81%
passes verifier-gated buyout initiation. Record delegation checkpoints, proposal states, timelock
execution and the fact that automatic debit/closeout remains disabled. A02 never enters a production
manifest or any mainnet.

## Track C — OpenSea discovery and mirror

OpenSea's current testnet surface exposes Base Sepolia and supports ERC-1155 discovery. After the
receipts are final, verify the collection/token pages or supported API responses for all formal IDs
and isolated A02. Record observation time, chain, contract, token ID, quantity, owner, metadata and
response digest. Metadata intentionally has no `image` field: absence of a preview is expected and
must not be "fixed" by publishing protected artwork.

The ArtFi UI mirrors corresponding OpenSea information without an OpenSea jump button. Discovery,
order creation and real-time mirroring are separate evidence tracks. A testnet listing, if the
current OpenSea surface permits it, requires an additional exact unsigned order/payload policy and
local wallet approval; otherwise record the external limitation and validate the Seaport path by
simulation. Never claim OpenSea acceptance from a standards probe alone.

## Acceptance and fail-closed rules

Evidence includes commit, UTC time, chain identity, public addresses, bytecode/metadata hashes,
transactions, receipts, blocks, gas, events, balances, proposal transitions and OpenSea URLs or API
responses. Missing chain identity, metadata mismatch, an A02 namespace leak, unexpected privilege,
failed simulation, nonce conflict, unavailable signer, unsupported OpenSea action or any mainnet
target stops execution. Test success does not authorize production or the ArtFi exchange.
