// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Valueless Hoodi mechanics inputs, never an institutional warehouse receipt.
/// @dev Isolated from ArtFiRWA and its source authority. No production evidence is fabricated.
contract ArtFiHoodiTestNFT is ERC721URIStorage, ReentrancyGuard {
    uint256 public constant TEST_CHAIN_ID = 560_048;
    uint256 public constant MAX_METADATA_URI_BYTES = 512;
    string public constant TEST_DISCLAIMER = "TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT";

    // Explicit wire values. Neither kind asserts warehouse custody or legal title.
    uint8 public constant SIMULATED_WAREHOUSE = 0;
    uint8 public constant DIGITAL_NATIVE_ARTWORK = 1;

    address public immutable issuer;
    bytes32 public immutable taskId;
    uint256 public mintedCount;

    struct TestSource {
        bytes32 sourceHash;
        bytes32 metadataHash;
        uint8 assetKind;
    }

    mapping(uint256 tokenId => TestSource source) private _sources;
    mapping(bytes32 sourceHash => uint256 tokenId) public tokenBySourceHash;

    error UnsupportedChain(uint256 chainId);
    error InvalidIssuer();
    error InvalidTaskId();
    error UnauthorizedIssuer(address caller);
    error InvalidAssetKind(uint8 kind);
    error EmptySourceHash();
    error EmptyMetadataHash();
    error DuplicateSource(bytes32 sourceHash);
    error InvalidMetadataURI();

    event TestNFTMinted(
        uint256 indexed tokenId,
        bytes32 indexed taskId,
        bytes32 indexed sourceHash,
        address issuer,
        uint8 assetKind,
        bytes32 metadataHash,
        string metadataURI
    );

    constructor(address issuer_, bytes32 taskId_) ERC721("TESTNET ArtFi - NO REAL-WORLD VALUE", "ARTFI-TEST") {
        if (block.chainid != TEST_CHAIN_ID) revert UnsupportedChain(block.chainid);
        if (issuer_ == address(0)) revert InvalidIssuer();
        if (taskId_ == bytes32(0)) revert InvalidTaskId();
        issuer = issuer_;
        taskId = taskId_;
    }

    /// @notice One test token for an explicitly hashed test source, minted to the fixed issuer.
    /// @dev Hashes are caller-supplied byte commitments, not verified external authority.
    ///      Wallet policy must bind the actual deployment, issuer, task, source and metadata.
    function mintTestNFT(bytes32 sourceHash, uint8 assetKind, bytes32 metadataHash, string calldata metadataURI)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        if (block.chainid != TEST_CHAIN_ID) revert UnsupportedChain(block.chainid);
        if (msg.sender != issuer) revert UnauthorizedIssuer(msg.sender);
        if (sourceHash == bytes32(0)) revert EmptySourceHash();
        if (metadataHash == bytes32(0)) revert EmptyMetadataHash();
        if (assetKind > DIGITAL_NATIVE_ARTWORK) revert InvalidAssetKind(assetKind);
        if (tokenBySourceHash[sourceHash] != 0) revert DuplicateSource(sourceHash);
        if (!_validURI(metadataURI)) revert InvalidMetadataURI();

        tokenId = ++mintedCount;
        tokenBySourceHash[sourceHash] = tokenId;
        _sources[tokenId] = TestSource(sourceHash, metadataHash, assetKind);
        _safeMint(issuer, tokenId);
        _setTokenURI(tokenId, metadataURI);
        emit TestNFTMinted(tokenId, taskId, sourceHash, issuer, assetKind, metadataHash, metadataURI);
    }

    function testSource(uint256 tokenId) external view returns (TestSource memory) {
        _requireOwned(tokenId);
        return _sources[tokenId];
    }

    function _validURI(string calldata metadataURI) private pure returns (bool) {
        bytes calldata value = bytes(metadataURI);
        if (value.length == 0 || value.length > MAX_METADATA_URI_BYTES) return false;
        bytes memory prefix;
        if (value.length > 8 && value[0] == "h") prefix = bytes("https://");
        else if (value.length > 7 && value[0] == "i") prefix = bytes("ipfs://");
        else return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (value[i] != prefix[i]) return false;
        }
        // Reject whitespace/control bytes, including whitespace-only suffixes and embedded NUL.
        for (uint256 i; i < value.length; ++i) {
            if (uint8(value[i]) <= 0x20 || uint8(value[i]) == 0x7f) return false;
        }
        return true;
    }
}
