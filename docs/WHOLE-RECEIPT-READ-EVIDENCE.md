# Complete Oracle receipt reader evidence

The Oracle receipt read extension returns eight top-level fields: tokenId,
source, block, entry, mintPolicyHash, receiptBinding, receiptAvailable and
evidence. The application HTTP reader retains that complete envelope. Removing
evidence to fit a seven-field decoder would lose the producer's observation
metadata.

The existing evidence contract is exactly canonical-contract-state, a head
with canonical decimal number and nonzero block hash, and integer
minimumConfirmations from 1 through 256. The application checks an inclusive
head-minus-anchor-plus-one count with full-width integer arithmetic, refuses
a head behind its anchor, and requires identical hashes at equal height.
Unknown root, evidence and head fields remain refused. Missing HTTP evidence,
malformed metadata or contradictory observation fields remain unavailable.

These checks establish structural consistency only. They do not establish
actual confirmation depth, chain finality, original-document correctness,
source authority, a stored grant or permission to move funds. Existing
authorization, finality and originalDocumentVerification results remain
NOT_ESTABLISHED. The canonical verifier independently checks its selected
provider, exact code and state at the EIP-1898 anchor and finalized blocks;
the retained HTTP evidence cannot replace those reads or temporal finality.

Internal snapshots reconstructed by the canonical RPC verifier may still have
seven fields. Only that existing in-process observation function accepts the
internal form; the HTTP read-response function requires reader evidence.
If evidence is present, both functions validate and detach it, and canonical
verification retains it without treating it as execution authority.

The source contract is the Oracle application's optional extension, not an
ERC-8415 normative schema:
[receipt read contract](https://github.com/GiraffeTechnology/Oracle/blob/52d1c929e9ae1da519d7ca2430c9d779cdbe3a42/docs/RECEIPT_READ_API.md).
This change adds no default endpoint, credentials, signing method, funds
operation, institution parser or replacement NFTReceiptAuthority. Approved
original profile and source/asset/segment/journal mappings remain required
by their actual integration paths.
