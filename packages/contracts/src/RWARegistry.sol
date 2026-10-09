// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {RWASourceVerifier} from "./RWASourceVerifier.sol";

import {ArtFiRWA} from "./ArtFiRWA.sol";

/// @title ArtFi RWA Registry
/// @notice Validates and records immutable RWA metadata commitments before minting ArtFiRWA.
contract RWARegistry is AccessControl, Pausable, ReentrancyGuard, RWASourceVerifier {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant MAX_URI_LENGTH = 512;

    struct Asset {
        address creator;
        address recipient;
        uint256 tokenId;
        bytes32 metadataHash;
        bytes32 intentHash;
        uint64 createdAt;
        string metadataURI;
    }

    error SourceEvidenceRequired();
    error AssetAlreadyBound();
    error EmptyRequestId();
    error IdempotencyConflict(bytes32 requestId);
    error InvalidMetadataHash();
    error InvalidMetadataURI();
    error UnknownRequest(bytes32 requestId);
    error ZeroAddress();

    event AssetCreated(
        bytes32 indexed requestId,
        uint256 indexed tokenId,
        address indexed recipient,
        address creator,
        bytes32 metadataHash,
        string metadataURI
    );

    ArtFiRWA public immutable nft;
    uint256 public assetCount;

    mapping(bytes32 requestId => uint256 tokenId) private _tokenByRequest;
    mapping(bytes32 assetKey => uint256 tokenId) public tokenByUnderlyingAsset;
    mapping(bytes32 sourceAssetKey => uint256 tokenId) public tokenBySourceAsset;
    mapping(uint256 tokenId => bytes32 evidenceDigest) public assetEvidence;
    mapping(uint256 tokenId => Asset asset) private _assets;

    constructor(
        ArtFiRWA nft_,
        address admin,
        address registrar,
        address pauser,
        address sourceAuthority_,
        bool testOnly
    ) RWASourceVerifier(sourceAuthority_, testOnly) {
        if (sourceAuthority_ == admin || sourceAuthority_ == registrar) {
            revert SourceAuthorityRequired();
        }
        if (
            address(nft_) == address(0) || admin == address(0) || registrar == address(0)
                || pauser == address(0)
        ) revert ZeroAddress();

        nft = nft_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, registrar);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Legacy metadata-only issuance is permanently disabled, even for registrars.
    function createAsset(bytes32, address, string calldata, bytes32)
        external
        pure
        returns (uint256)
    {
        revert SourceEvidenceRequired();
    }

    /// @notice Mint one source-authenticated underlying RWA representation.
    /// Whole commercial receipts remain externally issued ERC-8415 assets consumed through Oracle.
    function createAssetWithEvidence(
        bytes32 requestId,
        address recipient,
        string calldata metadataURI,
        bytes32 metadataHash,
        Evidence calldata evidence,
        bytes32 signatureR,
        bytes32 signatureS
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused nonReentrant returns (uint256 tokenId) {
        if (requestId == bytes32(0)) revert EmptyRequestId();
        if (recipient == address(0)) revert ZeroAddress();
        if (metadataHash == bytes32(0)) revert InvalidMetadataHash();
        if (!_validURI(metadataURI)) revert InvalidMetadataURI();

        bytes32 intentHash = keccak256(abi.encode(recipient, metadataURI, metadataHash));
        tokenId = _tokenByRequest[requestId];
        if (tokenId != 0) {
            if (_assets[tokenId].intentHash != intentHash) {
                revert IdempotencyConflict(requestId);
            }
            return tokenId;
        }

        bytes32 contextHash = _mintContext(requestId, recipient, metadataHash, metadataURI);
        bytes32 digest = _checkEvidence(evidence, contextHash, signatureR, signatureS);
        if (
            tokenByUnderlyingAsset[evidence.assetKey] != 0
                || tokenBySourceAsset[
                        keccak256(abi.encode(evidence.sourceIdHash, evidence.sourceAssetHash))
                    ] != 0
        ) revert AssetAlreadyBound();
        _commitEvidence(evidence, digest);
        tokenId = _mintAndRecord(requestId, recipient, metadataURI, metadataHash, intentHash);
        tokenByUnderlyingAsset[evidence.assetKey] = tokenId;
        tokenBySourceAsset[keccak256(abi.encode(evidence.sourceIdHash, evidence.sourceAssetHash))] =
            tokenId;
        assetEvidence[tokenId] = digest;
    }

    function _mintContext(
        bytes32 requestId,
        address recipient,
        bytes32 metadataHash,
        string calldata metadataURI
    ) private view returns (bytes32) {
        return sha256(
            abi.encode(
                block.chainid,
                address(this),
                requestId,
                recipient,
                metadataHash,
                sha256(bytes(metadataURI))
            )
        );
    }

    function _mintAndRecord(
        bytes32 requestId,
        address recipient,
        string calldata metadataURI,
        bytes32 metadataHash,
        bytes32 intentHash
    ) private returns (uint256 tokenId) {
        tokenId = nft.safeMint(recipient, metadataURI);
        _tokenByRequest[requestId] = tokenId;
        _assets[tokenId] = Asset({
            creator: msg.sender,
            recipient: recipient,
            tokenId: tokenId,
            metadataHash: metadataHash,
            intentHash: intentHash,
            createdAt: uint64(block.timestamp),
            metadataURI: metadataURI
        });
        assetCount++;
        emit AssetCreated(requestId, tokenId, recipient, msg.sender, metadataHash, metadataURI);
    }

    function assetByRequest(bytes32 requestId) external view returns (Asset memory) {
        uint256 tokenId = _tokenByRequest[requestId];
        if (tokenId == 0) revert UnknownRequest(requestId);
        return _assets[tokenId];
    }

    function assetByToken(uint256 tokenId) external view returns (Asset memory) {
        if (_assets[tokenId].tokenId == 0) revert UnknownRequest(bytes32(tokenId));
        return _assets[tokenId];
    }

    function tokenByRequest(bytes32 requestId) external view returns (uint256) {
        return _tokenByRequest[requestId];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _validURI(string calldata metadataURI) private pure returns (bool) {
        bytes calldata value = bytes(metadataURI);
        if (value.length == 0 || value.length > MAX_URI_LENGTH) return false;
        return _startsWith(value, "ipfs://") || _startsWith(value, "https://");
    }

    function _startsWith(bytes calldata value, string memory prefix) private pure returns (bool) {
        bytes memory expected = bytes(prefix);
        if (value.length < expected.length) return false;
        for (uint256 i; i < expected.length; ++i) {
            if (value[i] != expected[i]) return false;
        }
        return true;
    }
}
