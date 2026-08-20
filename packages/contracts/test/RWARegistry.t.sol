// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {RWARegistry} from "../src/RWARegistry.sol";

contract UntrustedCaller {
    function create(
        RWARegistry registry,
        bytes32 requestId,
        address recipient,
        string calldata metadataURI,
        bytes32 metadataHash
    ) external returns (uint256) {
        return registry.createAsset(requestId, recipient, metadataURI, metadataHash);
    }
}

contract RWARegistryTest {
    ArtFiRWA private nft;
    RWARegistry private registry;
    UntrustedCaller private untrusted;

    string private constant VALID_URI = "ipfs://bafy-stage-2-metadata";
    bytes32 private constant METADATA_HASH = keccak256("metadata");

    function setUp() public {
        nft = new ArtFiRWA("ArtFi RWA", "ARWA", address(this), address(this), address(this));
        registry = new RWARegistry(nft, address(this), address(this), address(this));
        nft.grantRole(nft.MINTER_ROLE(), address(registry));
        nft.renounceRole(nft.MINTER_ROLE(), address(this));
        untrusted = new UntrustedCaller();
    }

    /// @dev Restrict the invariant runner to the public handler on this test contract. Without
    ///      this list Foundry can impersonate deployed contract addresses, which is impossible
    ///      for an external transaction but would bypass the registry-only mint boundary.
    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(this);
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"));
    }

    function testCreateAssetCommitsMetadataAndMints() public {
        bytes32 requestId = keccak256("request-1");
        uint256 tokenId = registry.createAsset(requestId, address(this), VALID_URI, METADATA_HASH);

        require(tokenId == 1, "unexpected token id");
        require(nft.ownerOf(tokenId) == address(this), "owner mismatch");
        require(keccak256(bytes(nft.tokenURI(tokenId))) == keccak256(bytes(VALID_URI)), "uri");
        require(registry.assetCount() == 1, "asset count");
        require(registry.tokenByRequest(requestId) == tokenId, "request lookup");

        RWARegistry.Asset memory asset = registry.assetByToken(tokenId);
        require(asset.creator == address(this), "creator mismatch");
        require(asset.recipient == address(this), "recipient mismatch");
        require(asset.metadataHash == METADATA_HASH, "metadata hash mismatch");
    }

    function testIdenticalReplayIsIdempotent() public {
        bytes32 requestId = keccak256("request-replay");
        uint256 first = registry.createAsset(requestId, address(this), VALID_URI, METADATA_HASH);
        uint256 replay = registry.createAsset(requestId, address(this), VALID_URI, METADATA_HASH);

        require(first == replay, "replay minted a new token");
        require(registry.assetCount() == 1, "replay changed count");
        require(nft.nextTokenId() == 2, "replay advanced token id");
    }

    function testConflictingReplayReverts() public {
        bytes32 requestId = keccak256("request-conflict");
        registry.createAsset(requestId, address(this), VALID_URI, METADATA_HASH);

        (bool ok,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.createAsset,
                    (requestId, address(this), "ipfs://different", METADATA_HASH)
                )
            );
        require(!ok, "conflicting replay accepted");
        require(registry.assetCount() == 1, "conflict changed count");
    }

    function testUnauthorizedCallerCannotCreate() public {
        (bool ok,) = address(untrusted)
            .call(
                abi.encodeCall(
                    untrusted.create,
                    (registry, keccak256("unauthorized"), address(this), VALID_URI, METADATA_HASH)
                )
            );
        require(!ok, "unauthorized mint succeeded");
        require(registry.assetCount() == 0, "unauthorized mint changed state");
    }

    function testRegistryPauseBlocksCreation() public {
        registry.pause();
        (bool ok,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.createAsset,
                    (keccak256("paused"), address(this), VALID_URI, METADATA_HASH)
                )
            );
        require(!ok, "paused registry created asset");

        registry.unpause();
        uint256 tokenId =
            registry.createAsset(keccak256("unpaused"), address(this), VALID_URI, METADATA_HASH);
        require(tokenId == 1, "unpause did not recover");
    }

    function testNftPauseBlocksTransfers() public {
        uint256 tokenId = registry.createAsset(
            keccak256("transfer-pause"), address(this), VALID_URI, METADATA_HASH
        );
        nft.pause();
        (bool ok,) = address(nft)
            .call(abi.encodeCall(nft.transferFrom, (address(this), address(0xBEEF), tokenId)));
        require(!ok, "paused NFT transferred");

        nft.unpause();
        nft.transferFrom(address(this), address(0xBEEF), tokenId);
        require(nft.ownerOf(tokenId) == address(0xBEEF), "unpause did not recover");
    }

    function testInvalidMetadataInputsRevert() public {
        _requireCreateFails(bytes32(0), address(this), VALID_URI, METADATA_HASH);
        _requireCreateFails(keccak256("zero-recipient"), address(0), VALID_URI, METADATA_HASH);
        _requireCreateFails(keccak256("zero-hash"), address(this), VALID_URI, bytes32(0));
        _requireCreateFails(keccak256("empty-uri"), address(this), "", METADATA_HASH);
        _requireCreateFails(
            keccak256("bad-scheme"), address(this), "http://metadata.example", METADATA_HASH
        );
    }

    function testFuzzValidCommitments(bytes32 requestId, address recipient, bytes32 metadataHash)
        public
    {
        if (requestId == bytes32(0) || recipient == address(0) || metadataHash == bytes32(0)) {
            return;
        }
        // ERC-721 safe mint intentionally rejects contracts that do not implement the receiver
        // interface; this property test focuses on valid EOA and compatible-contract recipients.
        if (recipient.code.length > 0 && recipient != address(this)) return;
        uint256 tokenId = registry.createAsset(requestId, recipient, VALID_URI, metadataHash);
        require(nft.ownerOf(tokenId) == recipient, "fuzz owner mismatch");
        require(registry.assetByToken(tokenId).metadataHash == metadataHash, "fuzz hash mismatch");
    }

    /// @dev Called by Foundry's invariant runner with arbitrary inputs.
    function mintInvariant(bytes32 requestId, address recipient, bytes32 metadataHash) external {
        if (requestId == bytes32(0)) requestId = bytes32(uint256(1));
        if (recipient == address(0)) recipient = address(1);
        if (metadataHash == bytes32(0)) metadataHash = bytes32(uint256(1));
        try registry.createAsset(requestId, recipient, VALID_URI, metadataHash) {} catch {}
    }

    function invariantSupplyMatchesRegistryCount() public view {
        require(nft.nextTokenId() == registry.assetCount() + 1, "supply/count invariant");
    }

    function _requireCreateFails(
        bytes32 requestId,
        address recipient,
        string memory metadataURI,
        bytes32 metadataHash
    ) private {
        (bool ok,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.createAsset, (requestId, recipient, metadataURI, metadataHash)
                )
            );
        require(!ok, "invalid metadata accepted");
    }
}
