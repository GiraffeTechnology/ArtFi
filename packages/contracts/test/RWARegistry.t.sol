// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {RWARegistry} from "../src/RWARegistry.sol";
import {RWASourceVerifier} from "../src/RWASourceVerifier.sol";

interface SourceVm {
    function randomUint() external returns (uint256);
    function publicKeyP256(uint256 privateKey) external pure returns (uint256, uint256);
    function signP256(uint256 privateKey, bytes32 digest) external pure returns (bytes32, bytes32);
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 chainId) external;
}

contract RWARegistryTest {
    SourceVm private constant VM =
        SourceVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    ArtFiRWA private nft;
    RWARegistry private registry;
    uint256 private sourceKey;
    address private constant SOURCE_AUTHORITY = address(0x5100);
    bytes32 private constant SOURCE_ID = sha256("test-only-custody");
    string private constant VALID_URI = "ipfs://TEST_ONLY-source-authenticated-metadata";
    bytes32 private constant METADATA_HASH = sha256("TEST_ONLY metadata");

    function setUp() public {
        VM.chainId(31337);
        VM.warp(1_000_000);
        // Ephemeral, in-memory synthetic source key. It is never a fixture file,
        // deployment input, real signing account, or production source identity.
        sourceKey = VM.randomUint() % (N - 1) + 1;
        nft = new ArtFiRWA("TEST_ONLY RWA", "TEST", address(this), address(this), address(this));
        registry = new RWARegistry(
            nft, address(this), address(this), address(this), SOURCE_AUTHORITY, true
        );
        nft.bindMintRegistry(address(registry));
        nft.grantRole(nft.MINTER_ROLE(), address(registry));
        nft.renounceRole(nft.MINTER_ROLE(), address(this));
        (uint256 x, uint256 y) = VM.publicKeyP256(sourceKey);
        VM.startPrank(SOURCE_AUTHORITY);
        registry.configureSource(SOURCE_ID, bytes32(x), bytes32(y), true);
        VM.stopPrank();
    }

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

    function _evidence(bytes32 requestId) private pure returns (RWASourceVerifier.Evidence memory) {
        return RWASourceVerifier.Evidence(
            SOURCE_ID,
            sha256(abi.encode(requestId, "source asset")),
            sha256(abi.encode(requestId, "underlying asset")),
            sha256(abi.encode(requestId, "evidence")),
            sha256("TEST_ONLY custody correspondence; no real entitlement"),
            999_999,
            2_000_000,
            sha256("TEST_ONLY"),
            sha256("fractional")
        );
    }

    function _signed(
        RWASourceVerifier.Evidence memory e,
        bytes32 id,
        address recipient,
        bytes32 metadata
    ) private view returns (bytes32 r, bytes32 s) {
        bytes32 contextHash = sha256(
            abi.encode(
                block.chainid, address(registry), id, recipient, metadata, sha256(bytes(VALID_URI))
            )
        );
        (r, s) = VM.signP256(sourceKey, registry.sourceEvidenceDigest(e, contextHash));
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
    }

    function _mint(bytes32 id, address recipient, string memory uri, bytes32 metadata)
        private
        returns (uint256)
    {
        RWASourceVerifier.Evidence memory e = _evidence(id);
        (bytes32 r, bytes32 s) = _signed(e, id, recipient, metadata);
        return registry.createAssetWithEvidence(id, recipient, uri, metadata, e, r, s);
    }

    function _fails(
        bytes32 id,
        address recipient,
        string memory uri,
        bytes32 metadata,
        RWASourceVerifier.Evidence memory e,
        bytes32 r,
        bytes32 s
    ) private {
        (bool ok,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.createAssetWithEvidence, (id, recipient, uri, metadata, e, r, s)
                )
            );
        require(!ok, "invalid source issuance accepted");
    }

    function testApprovedSourceMintAndIdenticalReplay() public {
        bytes32 id = sha256("one");
        uint256 token = _mint(id, address(this), VALID_URI, METADATA_HASH);
        require(token == 1 && nft.ownerOf(token) == address(this), "wrong mint");
        require(_mint(id, address(this), VALID_URI, METADATA_HASH) == token, "replay minted again");
        require(nft.nextTokenId() == 2 && registry.assetCount() == 1, "replay count");
        require(registry.tokenByRequest(id) == token, "request binding");
        require(registry.assetByToken(token).metadataHash == METADATA_HASH, "metadata commitment");
        require(registry.assetEvidence(token) != bytes32(0), "source evidence missing");
    }

    function testLegacyRegistrarMintAlwaysFails() public {
        (bool ok,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.createAsset,
                    (sha256("legacy"), address(this), VALID_URI, METADATA_HASH)
                )
            );
        require(!ok && registry.assetCount() == 0, "metadata-only mint remained enabled");
    }

    function testPrivilegedNftMinterCannotBypassSealedRegistry() public {
        nft.grantRole(nft.MINTER_ROLE(), address(this));
        (bool ok,) = address(nft).call(abi.encodeCall(nft.safeMint, (address(this), VALID_URI)));
        require(!ok, "admin minter bypassed source registry");
        (ok,) = address(nft).call(abi.encodeCall(nft.bindMintRegistry, (address(registry))));
        require(!ok, "registry seal replaced");
    }

    function testRegistrarCannotApproveSourceKey() public {
        (uint256 x, uint256 y) = VM.publicKeyP256(sourceKey);
        (bool ok,) = address(registry)
            .call(
                abi.encodeCall(registry.configureSource, (SOURCE_ID, bytes32(x), bytes32(y), true))
            );
        require(!ok, "ArtFi role created source authority");
    }

    function testNoSourceEvidenceOrWrongSigner() public {
        bytes32 id = sha256("bad-signature");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        _fails(
            id, address(this), VALID_URI, METADATA_HASH, e, bytes32(uint256(1)), bytes32(uint256(1))
        );
        e.sourceIdHash = sha256("unapproved");
        (bytes32 r, bytes32 s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
    }

    function testSourceBoundToRecipientMetadataRequestRegistryAndChain() public {
        bytes32 id = sha256("bindings");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        (bytes32 r, bytes32 s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(0xBEEF), VALID_URI, METADATA_HASH, e, r, s);
        _fails(sha256("other"), address(this), VALID_URI, METADATA_HASH, e, r, s);
        _fails(id, address(this), VALID_URI, sha256("changed"), e, r, s);
        VM.chainId(560048);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        VM.chainId(31337);
        RWARegistry other = new RWARegistry(
            nft, address(this), address(this), address(this), SOURCE_AUTHORITY, true
        );
        (uint256 x, uint256 y) = VM.publicKeyP256(sourceKey);
        VM.startPrank(SOURCE_AUTHORITY);
        other.configureSource(SOURCE_ID, bytes32(x), bytes32(y), true);
        VM.stopPrank();
        (bool ok,) = address(other)
            .call(
                abi.encodeCall(
                    other.createAssetWithEvidence,
                    (id, address(this), VALID_URI, METADATA_HASH, e, r, s)
                )
            );
        require(!ok, "cross-registry replay accepted");
    }

    function testSourceExpiryFutureWrongModeAndWrongModel() public {
        bytes32 id = sha256("validity");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        e.validUntil = 1_000_000;
        (bytes32 r, bytes32 s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        e = _evidence(id);
        e.validFrom = 1_000_001;
        (r, s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        e = _evidence(id);
        e.modeHash = sha256("LIVE");
        (r, s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        e = _evidence(id);
        e.sectionHash = sha256("whole");
        (r, s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
    }

    function testUnderlyingIdentityCannotMintTwice() public {
        bytes32 id = sha256("unique");
        _mint(id, address(this), VALID_URI, METADATA_HASH);
        RWASourceVerifier.Evidence memory e = _evidence(id);
        e.evidenceId = sha256("second evidence");
        bytes32 second = sha256("second request");
        (bytes32 r, bytes32 s) = _signed(e, second, address(this), METADATA_HASH);
        _fails(second, address(this), VALID_URI, METADATA_HASH, e, r, s);
        require(registry.assetCount() == 1, "duplicate underlying minted");
    }

    function testSourceEvidenceIdCannotChangeClaim() public {
        bytes32 id = sha256("evidence-id");
        _mint(id, address(this), VALID_URI, METADATA_HASH);
        RWASourceVerifier.Evidence memory e = _evidence(id);
        e.assetKey = sha256("another asset");
        bytes32 second = sha256("another request");
        (bytes32 r, bytes32 s) = _signed(e, second, address(this), METADATA_HASH);
        _fails(second, address(this), VALID_URI, METADATA_HASH, e, r, s);
    }

    function testSignedSourceRevocationBeforeMintAndAfterMintDoesNotFreezeOwner() public {
        bytes32 id = sha256("revoked");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        bytes32 reason = sha256("TEST_ONLY revocation");
        bytes32 digest = sha256(
            abi.encode(
                registry.REVOCATION_DOMAIN(),
                SOURCE_ID,
                e.evidenceId,
                uint64(1_000_000),
                reason,
                sha256("TEST_ONLY")
            )
        );
        (bytes32 r, bytes32 s) = VM.signP256(sourceKey, digest);
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        registry.revokeSourceEvidence(SOURCE_ID, e.evidenceId, 1_000_000, reason, r, s);
        (r, s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        id = sha256("minted owner exit");
        uint256 token = _mint(id, address(this), VALID_URI, METADATA_HASH);
        VM.warp(2_000_001);
        nft.pause();
        nft.transferFrom(address(this), address(0xBEEF), token);
        require(nft.ownerOf(token) == address(0xBEEF), "expired evidence froze owner");
    }

    function testSourceDisableRejectsNewIssuance() public {
        (uint256 x, uint256 y) = VM.publicKeyP256(sourceKey);
        VM.startPrank(SOURCE_AUTHORITY);
        registry.configureSource(SOURCE_ID, bytes32(x), bytes32(y), false);
        VM.stopPrank();
        bytes32 id = sha256("disabled");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        (bytes32 r, bytes32 s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
    }

    function testPauseAndUnauthorizedRegistrarStillApply() public {
        bytes32 id = sha256("paused");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        (bytes32 r, bytes32 s) = _signed(e, id, address(this), METADATA_HASH);
        registry.pause();
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        registry.unpause();
        VM.startPrank(address(0xBAD));
        _fails(id, address(this), VALID_URI, METADATA_HASH, e, r, s);
        VM.stopPrank();
        require(_mint(id, address(this), VALID_URI, METADATA_HASH) == 1, "unpause failed");
    }

    function testInvalidMetadataAndConflictingReplay() public {
        bytes32 id = sha256("metadata");
        RWASourceVerifier.Evidence memory e = _evidence(id);
        (bytes32 r, bytes32 s) = _signed(e, id, address(this), METADATA_HASH);
        _fails(bytes32(0), address(this), VALID_URI, METADATA_HASH, e, r, s);
        _fails(id, address(0), VALID_URI, METADATA_HASH, e, r, s);
        _fails(id, address(this), VALID_URI, bytes32(0), e, r, s);
        _fails(id, address(this), "http://invalid.test", METADATA_HASH, e, r, s);
        _mint(id, address(this), VALID_URI, METADATA_HASH);
        _fails(id, address(this), "ipfs://changed", METADATA_HASH, e, r, s);
    }

    function testUnsealedNftCannotMint() public {
        ArtFiRWA unsealed =
            new ArtFiRWA("TEST_ONLY", "TEST", address(this), address(this), address(this));
        (bool ok,) =
            address(unsealed).call(abi.encodeCall(unsealed.safeMint, (address(this), VALID_URI)));
        require(!ok, "unsealed issuance accepted");
    }

    function testFuzzValidCommitments(bytes32 id, address recipient, bytes32 metadata) public {
        if (
            id == bytes32(0) || recipient == address(0) || metadata == bytes32(0)
                || (recipient.code.length > 0 && recipient != address(this))
        ) return;
        uint256 token = _mint(id, recipient, VALID_URI, metadata);
        require(nft.ownerOf(token) == recipient, "wrong owner");
    }

    function mintInvariant(bytes32 id, address recipient, bytes32 metadata) external {
        if (id == bytes32(0)) id = bytes32(uint256(1));
        if (recipient == address(0)) recipient = address(1);
        if (metadata == bytes32(0)) metadata = bytes32(uint256(1));
        RWASourceVerifier.Evidence memory e = _evidence(id);
        (bytes32 r, bytes32 s) = _signed(e, id, recipient, metadata);
        try registry.createAssetWithEvidence(id, recipient, VALID_URI, metadata, e, r, s) {}
            catch {}
    }

    function invariantSupplyMatchesRegistryCount() public view {
        require(nft.nextTokenId() == registry.assetCount() + 1, "supply/count mismatch");
    }
}
