# Dedicated wallet activation

Status: **AWAITING CUSTODY DECISION**
Last reviewed: 2026-08-20

No production wallet may be created as an unencrypted server hot key. Production signing must use
an approved hardware signer, institutional custody provider, or multi-signature wallet. Private
keys and seed phrases must never enter Git, `.env`, CI variables, logs, tickets, or chat.

## Keep wallet roles separate

| Role                          | Required controller                   | Purpose                                                             |
| ----------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| CCHS beneficiary wallet       | CCHS-approved signers                 | Receive charity proceeds and support CCHS accounting reconciliation |
| ArtFi deployment/admin wallet | ArtFi-approved multi-signature owners | Contract deployment, role administration, pause/timelock operations |
| Marketplace/indexer identity  | No signing key by default             | Read-only OpenSea and compliant-market mirroring                    |

ArtFi must not create or hold the CCHS beneficiary private key. CCHS must provide and attest its
beneficiary address through an approved out-of-band process.

## Inputs required before activation

1. exact wallet role and Ethereum network;
2. owner wallet addresses and independent identity verification;
3. multi-signature threshold (for example, `2-of-3` only when approved by the owners);
4. signer custody method and recovery contacts;
5. transaction limits, contract roles, timelock, emergency pause, and monitoring policy;
6. offline recovery/backup procedure and a recorded recovery exercise; and
7. a signed address-attestation record kept outside Git, with only its hash recorded in evidence.

## Activation evidence

Record the network, wallet address, wallet implementation/version, owners, threshold, creation
transaction, block, source commit, role assignments, monitoring owner, and attestation hash. Never
record private material. A wallet is not considered open until the owners complete a harmless
multi-signature test transaction and recovery responsibilities are accepted in writing.

The current abcdyi environment has no approved production keystore directory, password store,
encryption standard, backup location, or recovery drill. Server-side key generation therefore
remains prohibited until a custody design is approved.
