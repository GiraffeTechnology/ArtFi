// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @notice Application-side approved-source verifier. It is not an asset registry
/// of record, Oracle, certificate issuer, or custody authority. Source signatures
/// attest a bounded correspondence claim; metadata alone never proves an asset.
abstract contract RWASourceVerifier {
    bytes32 public constant EVIDENCE_DOMAIN = sha256("ArtFi approved-source evidence v1");
    bytes32 public constant REVOCATION_DOMAIN = sha256("ArtFi approved-source revocation v1");
    bytes32 public constant FRACTIONAL_MODEL = sha256("fractional");

    struct Source {
        bytes32 x;
        bytes32 y;
        bool enabled;
    }

    struct Evidence {
        bytes32 sourceIdHash;
        bytes32 sourceAssetHash;
        bytes32 assetKey;
        bytes32 evidenceId;
        bytes32 claimHash;
        uint64 validFrom;
        uint64 validUntil;
        bytes32 modeHash;
        bytes32 sectionHash;
    }

    // Immutable independent source authority is deliberately outside ArtFi's
    // DEFAULT_ADMIN_ROLE and REGISTRAR_ROLE hierarchy.
    address public immutable sourceAuthority;
    bytes32 public immutable evidenceMode;
    mapping(bytes32 => Source) public approvedSources;
    mapping(bytes32 => bool) public revokedEvidence;
    mapping(bytes32 => bytes32) public committedEvidence;

    error SourceAuthorityRequired();
    error InvalidSource();
    error InvalidSourceEvidence();
    error RevokedSourceEvidence();
    event SourceConfigured(bytes32 indexed sourceIdHash, bytes32 x, bytes32 y, bool enabled);
    event SourceEvidenceRevoked(
        bytes32 indexed sourceIdHash, bytes32 indexed evidenceId, bytes32 reasonHash
    );

    constructor(address sourceAuthority_, bool testOnly) {
        if (sourceAuthority_ == address(0)) revert SourceAuthorityRequired();
        sourceAuthority = sourceAuthority_;
        evidenceMode = testOnly ? sha256("TEST_ONLY") : sha256("LIVE");
        // Synthetic evidence cannot be enabled on an unbounded production chain.
        if (testOnly && block.chainid != 31337 && block.chainid != 560048) revert InvalidSource();
    }

    function configureSource(bytes32 sourceIdHash, bytes32 x, bytes32 y, bool enabled) external {
        if (msg.sender != sourceAuthority) revert SourceAuthorityRequired();
        if (sourceIdHash == bytes32(0) || !P256.isValidPublicKey(x, y)) revert InvalidSource();
        approvedSources[sourceIdHash] = Source(x, y, enabled);
        emit SourceConfigured(sourceIdHash, x, y, enabled);
    }

    function sourceEvidenceDigest(Evidence calldata e, bytes32 contextHash)
        public
        pure
        returns (bytes32)
    {
        return sha256(
            abi.encode(
                EVIDENCE_DOMAIN,
                e.sourceIdHash,
                e.sourceAssetHash,
                e.assetKey,
                e.evidenceId,
                e.claimHash,
                contextHash,
                e.validFrom,
                e.validUntil,
                e.modeHash,
                e.sectionHash
            )
        );
    }

    function revokeSourceEvidence(
        bytes32 sourceIdHash,
        bytes32 evidenceId,
        uint64 revokedAt,
        bytes32 reasonHash,
        bytes32 r,
        bytes32 s
    ) external {
        Source memory source = approvedSources[sourceIdHash];
        bytes32 digest = sha256(
            abi.encode(
                REVOCATION_DOMAIN, sourceIdHash, evidenceId, revokedAt, reasonHash, evidenceMode
            )
        );
        if (
            evidenceId == bytes32(0) || revokedAt == 0 || revokedAt > block.timestamp
                || !P256.verify(digest, r, s, source.x, source.y)
        ) revert InvalidSourceEvidence();
        revokedEvidence[keccak256(abi.encode(sourceIdHash, evidenceId))] = true;
        emit SourceEvidenceRevoked(sourceIdHash, evidenceId, reasonHash);
    }

    function _checkEvidence(Evidence calldata e, bytes32 contextHash, bytes32 r, bytes32 s)
        internal
        view
        returns (bytes32 digest)
    {
        Source memory source = approvedSources[e.sourceIdHash];
        if (
            !source.enabled || e.modeHash != evidenceMode || e.sectionHash != FRACTIONAL_MODEL
                || e.assetKey == bytes32(0) || e.sourceAssetHash == bytes32(0)
                || e.evidenceId == bytes32(0) || e.claimHash == bytes32(0) || e.validFrom == 0
                || e.validUntil <= e.validFrom || block.timestamp < e.validFrom
                || block.timestamp >= e.validUntil
        ) revert InvalidSourceEvidence();
        bytes32 key = keccak256(abi.encode(e.sourceIdHash, e.evidenceId));
        if (revokedEvidence[key]) revert RevokedSourceEvidence();
        digest = sourceEvidenceDigest(e, contextHash);
        bytes32 prior = committedEvidence[key];
        if (
            (prior != bytes32(0) && prior != digest)
                || !P256.verify(digest, r, s, source.x, source.y)
        ) {
            revert InvalidSourceEvidence();
        }
    }

    function _commitEvidence(Evidence calldata e, bytes32 digest) internal {
        committedEvidence[keccak256(abi.encode(e.sourceIdHash, e.evidenceId))] = digest;
    }
}
