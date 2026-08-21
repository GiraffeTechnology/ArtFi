# Sepolia Ethereum compatibility and NFT marketplace validation plan

## Decision

Sepolia is the required test chain. It is an Ethereum testnet, not a third-party EVM approximation,
and uses Ethereum chain ID `11155111`, Ethereum transaction encoding, ABI rules, EVM execution,
JSON-RPC semantics and the same ERC interface identifiers needed by the target contracts. A Sepolia
success is strong evidence of Ethereum deployability, but it does not by itself authorize mainnet,
real value, real title transfer, or production operation.

## P0 execution topology

All automated or operator-controlled interaction with a public chain or public NFT marketplace must
execute in the Singapore (SIN) public-chain zone. This includes RPC reads/writes, deployment,
receipt polling, chain indexing, source verification, explorer API calls, OpenSea API/Stream calls,
discovery and listing validation.

| Zone            | Allowed                                                                                               | Prohibited                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| abcdyi          | Clone through approved bridge, install, compile, unit/fuzz/invariant test, package and hash artifacts | Public RPC, broadcast, receipt polling, explorer/OpenSea calls |
| AIVAN           | Translation generation and Qwen proofread-only support                                                | Public chain, wallet, explorer or marketplace work             |
| CTYun MySQL/API | Durable business records, normalized evidence ingestion, admin/data services                          | Direct public RPC or OpenSea egress                            |
| SIN             | Public RPC, Sepolia deploy/probe/index, Etherscan verification, OpenSea discovery/mirror validation   | Storing signer material in Git/API/MySQL/CI                    |

Repository scripts require `ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE=sin` before they read an RPC setting.
The repository carries no default RPC URL. The SIN deployment layer injects runtime configuration
and references a test-only signer outside Git. A user-controlled external wallet remains the only
transaction signer; ArtFi services never receive its private key. For an operator test, the browser
and wallet session are run from the SIN test workstation/runner.

## Stage 0 — offline release candidate on abcdyi

1. Lock the Git commit, lockfile, Foundry version, Solidity `0.8.30`, optimizer settings and EVM
   target.
2. Run formatting, lint, TypeScript, Go, unit, fuzz, invariant, contract-size, Slither-equivalent,
   secret and release-package checks without any public RPC.
3. Generate ABI, creation bytecode, runtime bytecode expectation, source bundle, dependency/SBOM
   inventory and SHA-256 manifest.
4. Fail if a private key, mnemonic, signed transaction, public RPC default or non-approved network
   is present.

Pass evidence: commit, tool versions, command/exit-code log and artifact hashes. This stage cannot
claim chain deployment.

## Stage 1 — immutable handoff to SIN

1. Transfer only the reviewed commit/artifact bundle through the approved Singapore bridge.
2. Recompute every SHA-256 value on SIN and compare it with the release manifest.
3. Inject the RPC endpoint, explorer credential and test-only keystore references at runtime. Do not
   copy these values back to abcdyi, Git, logs, API or MySQL.
4. Confirm the execution-zone guard passes only on the designated SIN runner.

Pass evidence: matching hashes, runner attestation identifier and redacted configuration presence
report.

## Stage 2 — Ethereum JSON-RPC compatibility probe on SIN

Before deployment, record responses for:

- `eth_chainId` = `0xaa36a7` (`11155111`) and matching `net_version`;
- latest block, timestamp, gas limit and non-empty block hash;
- EIP-1559 `baseFeePerGas`, `eth_feeHistory` and `eth_maxPriorityFeePerGas` support;
- `eth_getCode`, `eth_getBalance`, `eth_getTransactionCount`, `eth_estimateGas` and `eth_call`;
- finalized/safe block tag support or an explicit provider limitation;
- client/provider identity without exposing credentials.

Fail closed on a chain-ID mismatch, missing fee data, inconsistent latest block, unsupported calls
required by the deployment scripts, or any response from a non-SIN run.

## Stage 3 — Sepolia deployment on SIN

Deploy only the reviewed scope:

1. `ArtFiRWA` and `RWARegistry`;
2. `ArtFiCharityEditions` when the charity package gate is satisfied;
3. `VaultFactory`, the single-asset Vault/fraction token contracts and approved governance stack;
4. no ArtFi market/orderbook/AMM contract.

For each deployment, capture UTC time, transaction hash, block number/hash, status, gas, contract
address, deployer public address, constructor arguments, compiler/settings hash, creation/runtime
bytecode hashes and source-verification result. A source verification failure blocks acceptance even
when bytecode exists.

## Stage 4 — ERC and security probes on SIN

### ERC-721

- ERC-165 `supportsInterface(0x01ffc9a7)`;
- ERC-721 `0x80ac58cd` and metadata `0x5b5e139f`;
- `name`, `symbol`, `tokenURI`, `ownerOf`, `balanceOf`, exact `Transfer` event;
- authorized mint and unauthorized mint rejection;
- pause/unpause authorization and paused-write rejection;
- zero address, duplicate request, malformed metadata and replay rejection.

### ERC-1155

- ERC-165, ERC-1155 `0xd9b67a26` and metadata `0x0e89341c`;
- `uri`, `balanceOf`, `totalSupply` and exact `TransferSingle`/`SeriesCreated` evidence;
- one work maps to one token ID, exactly 100 immutable units and no second issuance;
- recorded primary price constant is `0.01 ETH` in wei;
- creator/pause/duplicate artwork/master/metadata commitment negative tests.

### Vault and governance

- ERC-721 remains owned by the Vault after deposit/fractionalization;
- fixed fraction supply and ERC-20/ERC20Votes checkpoints;
- wallet-control nonce, positive share balance and historic snapshot rights;
- proposal threshold `10%`; strict category thresholds `>50%`, `>66.6667%`, `>80%`;
- selector/category binding, Timelock-only execution and replay/double-vote rejection;
- buyout price evidence verifier; no real escrow, debit, forced closeout or settlement.

Any mismatch between deployed runtime bytecode and the locked build is a hard failure.

## Stage 5 — real test artwork mint and wallet display from SIN

1. Use only a rights-cleared test work and a package containing source hash, public metadata hash,
   authorization, takedown contact and `TESTNET / NO REAL-WORLD TITLE TRANSFER` notice.
2. Mint one ERC-721 through the administrator control UI and one approved ERC-1155 test series when
   the charity gate permits it.
3. Require the external wallet to display the exact target, calldata summary and zero/unexpected
   value check before signing.
4. Match the receipt to the request ID, recipient/distribution wallet, commitments, token ID and
   contract address; then independently read ownership/balance/supply.
5. Exercise the wallet display-import instructions for ERC-721 and ERC-1155. Displaying an NFT is
   not evidence of approval, transfer or DAO membership.

No real ETH is required by this plan. If the designated test signer lacks Sepolia gas, broadcast is
recorded as blocked; offline and read-only probes continue, and no fake receipt is accepted.

## Stage 6 — OpenSea discovery and optional listing validation from SIN

1. Query OpenSea's current supported-chain surface at test time; do not assume Sepolia support from
   historic documentation.
2. Query the exact chain, collection, contract and token ID. Persist observation time, upstream
   status and a response digest.
3. Accept only `discovered`, `not-found` or `unsupported-chain`. `not-found` and
   `unsupported-chain` are valid evidence outcomes but are not marketplace acceptance.
4. Verify that public metadata does not expose a prohibited unwatermarked master or preview.
5. Listing is a separate explicit action requiring renewed approval of collection, token ID,
   quantity, price, currency, expiry, royalty and wallet transaction. This plan does not authorize
   listing.

OpenSea mirror validation is a separate track: the read-only mirror service runs in SIN, performs
REST backfill then Stream subscription, injects duplicates/out-of-order events, reconnects after an
interruption and proves convergence in the CTYun-backed read model. ArtFi does not create its own
order, matching engine or settlement.

## Stage 7 — recovery, reorg and evidence closeout

- restart the SIN indexer and prove checkpoint recovery;
- replay duplicate logs and removed/replacement logs without double counting;
- reconcile RPC receipt, explorer data, normalized backend evidence and UI state;
- test provider timeout, rate limit, wrong chain, stale OpenSea event and gateway outage;
- verify no secret or internal topology entered logs/evidence;
- bind the final evidence bundle to the exact commit and deployed runtime hashes.

## Acceptance result format

| Area                   | Pass condition                                                              | Hard failure                                                      |
| ---------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Ethereum compatibility | Chain ID, EIP-1559 RPC and exact bytecode/source evidence pass              | Wrong chain, unsupported required RPC, bytecode mismatch          |
| ERC-721                | Interfaces, metadata, ownership, events and negative authorization pass     | Missing interface, wrong owner/event, unauthorized mint succeeds  |
| ERC-1155               | Interfaces, metadata, fixed 100 supply, commitments and negative tests pass | Supply can increase, wrong URI/event, role/pause bypass           |
| Wallet                 | Exact external-wallet review, receipt match and display import pass         | Key enters service/CI, mismatched target/calldata/value           |
| DAO/Vault              | Custody, snapshots, thresholds, category and Timelock tests pass            | ArtCCH/admin override, duplicate vote, custody loss               |
| OpenSea                | Exact discovery outcome is recorded honestly                                | Unsupported/not-found represented as accepted or listed           |
| Topology               | Every public-chain/OpenSea action originates in SIN                         | Any abcdyi/AIVAN/MySQL public egress or unguarded operator script |

Mainnet remains gated after all testnet checks pass. A separate legal, compliance, custody,
security, operations and written go/no-go approval is required.
