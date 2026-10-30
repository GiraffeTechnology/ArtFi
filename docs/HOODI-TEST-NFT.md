# Isolated Hoodi ERC721 test inputs

`ArtFiHoodiTestNFT` supplies valueless ERC721 inputs for the authorized simulated
warehouse-record and digitally native artwork exercises. It is separate from
`ArtFiRWA`, its approved-source verifier, and the ERC1155 charity edition supply.
These tokens establish no warehouse custody, property title, donation, commercial
opening, or production source authenticity.

Deployment and mint both require chain 560048. Construction fixes the original
authorized issuer address and the task's approved opaque bytes32 identifier.
There is no administrator, issuer rotation, source replacement, metadata update,
burn, or production-chain override. The standard ERC721 transfer interfaces remain
available for the applicable Vault and market exercises.

The fixed nonpayable mint ABI is:

```solidity
mintTestNFT(bytes32 sourceHash, uint8 assetKind, bytes32 metadataHash, string metadataURI)
```

Only the immutable issuer can call it. It mints one token to that same issuer.
Kind 0 means a simulated warehouse record; kind 1 means digitally native artwork.
Source and metadata hashes are nonzero byte commitments supplied by the caller;
the contract does not authenticate their off-chain content. A source can mint
only once across both kinds. The immutable URI must be a nonempty HTTPS or IPFS
reference of at most 512 bytes without whitespace or control bytes.

Before execution, the server-owned test inventory must independently bind the
actual chain, deployed contract and runtime code hash, immutable issuer and task,
source hash, kind, metadata hash, and approved publication reference. The task ID
encoding is supplied by the original producer; this contract defines no new
encoding of application identifiers. No future token ID or receipt is required
for a planned mint. The controlled Wallet implementation supplies the exact
transaction, operation/grant, fee and nonce checks; this contract is not a signer
or an arbitrary-call authorization route.

After execution, reconcile the actual transaction and canonical receipt. Check
the ERC721 zero-address `Transfer`, `TestNFTMinted`, source lookup, immutable task
and issuer, owner, and token URI. Record the observed token ID, transaction and
block hash. An unknown submission must be reconciled before another send.
Mint evidence alone is not proof of later Vault custody, fractions, governance,
registry rights, UI operation, or complete product acceptance.

The deployment script follows the existing Forge broadcast pattern with explicit
nonsecret issuer and task bindings. It does not select a provider, create a wallet,
read a key, or authorize deployment. Source publication is not a deployed address
or runtime code hash. Independent compilation and affected tests, approved
deployment, controlled mint execution, and canonical receipt validation remain
separate evidence steps.
