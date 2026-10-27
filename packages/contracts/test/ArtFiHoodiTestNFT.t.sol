// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ArtFiHoodiTestNFT} from "../src/test-only/ArtFiHoodiTestNFT.sol";

interface VmTestNFT {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function expectRevert(bytes calldata revertData) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
}

contract TestNFTReceiver is IERC721Receiver {
    bool public reject;
    bool public attack;
    bool public reentryRejected;

    function configure(bool reject_, bool attack_) external {
        reject = reject_;
        attack = attack_;
    }

    function mint(ArtFiHoodiTestNFT nft, bytes32 source) external returns (uint256) {
        return nft.mintTestNFT(source, 1, sha256("metadata"), "ipfs://test-metadata");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (reject) return bytes4(0);
        if (attack) {
            (bool ok,) = msg.sender
                .call(
                    abi.encodeCall(
                        ArtFiHoodiTestNFT.mintTestNFT,
                        (sha256("nested-source"), uint8(1), sha256("nested-meta"), "ipfs://nested")
                    )
                );
            reentryRejected = !ok;
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract ArtFiHoodiTestNFTTest is IERC721Receiver {
    VmTestNFT private constant VM =
        VmTestNFT(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant TASK = bytes32(uint256(91));
    bytes32 private constant SOURCE = sha256("simulated input bytes");
    bytes32 private constant META = sha256("test metadata bytes");
    ArtFiHoodiTestNFT private nft;

    function setUp() public {
        VM.chainId(560_048);
        nft = new ArtFiHoodiTestNFT(address(this), TASK);
    }

    function testRejectsDeploymentOutsideHoodi() public {
        VM.chainId(1);
        VM.expectRevert(abi.encodeWithSelector(ArtFiHoodiTestNFT.UnsupportedChain.selector, 1));
        new ArtFiHoodiTestNFT(address(this), TASK);
    }

    function testRejectsMissingIssuerAndTask() public {
        VM.expectRevert(abi.encodeWithSelector(ArtFiHoodiTestNFT.InvalidIssuer.selector));
        new ArtFiHoodiTestNFT(address(0), TASK);
        VM.expectRevert(abi.encodeWithSelector(ArtFiHoodiTestNFT.InvalidTaskId.selector));
        new ArtFiHoodiTestNFT(address(this), bytes32(0));
    }

    function testOnlyOriginalIssuerCanMint() public {
        VM.prank(address(0xBEEF));
        (bool ok,) = address(nft)
            .call(abi.encodeCall(nft.mintTestNFT, (SOURCE, uint8(0), META, "ipfs://metadata")));
        require(!ok && nft.mintedCount() == 0, "unbound caller minted");
    }

    function testRejectsChainChangeBeforeMint() public {
        VM.chainId(11155111);
        _reject(SOURCE, 0, META, "ipfs://metadata");
    }

    function testMintsBothKindsWithActualSourceAndTaskBindings() public {
        for (uint8 kind; kind < 2; ++kind) {
            bytes32 source = kind == 0 ? SOURCE : sha256("digitally native bytes");
            uint256 id = nft.mintTestNFT(source, kind, META, "https://example.invalid/test.json");
            require(nft.ownerOf(id) == address(this), "wrong issuer recipient");
            require(nft.tokenBySourceHash(source) == id, "source lookup mismatch");
            ArtFiHoodiTestNFT.TestSource memory entry = nft.testSource(id);
            require(entry.sourceHash == source && entry.metadataHash == META, "hash mismatch");
            require(entry.assetKind == kind && nft.taskId() == TASK, "kind or task mismatch");
        }
        require(nft.mintedCount() == 2, "unexpected count");
        require(nft.issuer() == address(this), "issuer changed");
    }

    function testRejectsSourceReplayAcrossKinds() public {
        uint256 id = nft.mintTestNFT(SOURCE, 0, META, "ipfs://warehouse");
        _reject(SOURCE, 1, META, "ipfs://artwork");
        require(
            nft.mintedCount() == 1 && nft.tokenBySourceHash(SOURCE) == id, "replay mutated state"
        );
        require(keccak256(bytes(nft.tokenURI(id))) == keccak256("ipfs://warehouse"), "uri changed");
    }

    function testReceiptEventsBindActualTokenSourceTaskAndIssuer() public {
        VM.recordLogs();
        uint256 id = nft.mintTestNFT(SOURCE, 0, META, "ipfs://test-receipt");
        VmTestNFT.Log[] memory logs = VM.getRecordedLogs();
        bool transferSeen;
        bool sourceSeen;
        for (uint256 i; i < logs.length; ++i) {
            VmTestNFT.Log memory entry = logs[i];
            if (entry.emitter != address(nft)) continue;
            if (entry.topics[0] == keccak256("Transfer(address,address,uint256)")) {
                require(entry.topics.length == 4, "transfer topic count");
                require(entry.topics[1] == bytes32(0), "not a mint transfer");
                require(
                    entry.topics[2] == bytes32(uint256(uint160(address(this)))), "wrong recipient"
                );
                require(entry.topics[3] == bytes32(id), "wrong transfer token");
                transferSeen = true;
            }
            if (
                entry.topics[0]
                    == keccak256(
                        "TestNFTMinted(uint256,bytes32,bytes32,address,uint8,bytes32,string)"
                    )
            ) {
                require(entry.topics.length == 4, "source topic count");
                require(
                    entry.topics[1] == bytes32(id) && entry.topics[2] == TASK
                        && entry.topics[3] == SOURCE,
                    "source topic mismatch"
                );
                (address actualIssuer, uint8 kind, bytes32 metadataHash, string memory uri) =
                    abi.decode(entry.data, (address, uint8, bytes32, string));
                require(
                    actualIssuer == address(this) && kind == 0 && metadataHash == META,
                    "source data mismatch"
                );
                require(
                    keccak256(bytes(uri)) == keccak256("ipfs://test-receipt"), "source URI mismatch"
                );
                sourceSeen = true;
            }
        }
        require(transferSeen && sourceSeen, "mint evidence events missing");
    }

    function testRejectsMissingHashesAndUnsupportedKinds() public {
        _reject(bytes32(0), 0, META, "ipfs://metadata");
        _reject(SOURCE, 0, bytes32(0), "ipfs://metadata");
        _reject(SOURCE, 2, META, "ipfs://metadata");
        _reject(SOURCE, 255, META, "ipfs://metadata");
        require(
            nft.mintedCount() == 0 && nft.tokenBySourceHash(SOURCE) == 0, "invalid input consumed"
        );
    }

    function testRejectsInvalidMetadataReferences() public {
        string[8] memory uris = [
            "",
            "https://",
            "ipfs://",
            "http://insecure",
            "data:text/plain,simulation",
            "https://x.invalid/a b",
            "ipfs://a\n",
            "https://x.invalid/\x00"
        ];
        for (uint256 i; i < uris.length; ++i) {
            _reject(SOURCE, 0, META, uris[i]);
        }
        require(nft.mintedCount() == 0, "invalid URI minted");
    }

    function testMetadataLengthBoundaryAndImmutability() public {
        bytes memory uri = new bytes(512);
        bytes memory prefix = bytes("ipfs://");
        for (uint256 i; i < uri.length; ++i) {
            uri[i] = i < prefix.length ? prefix[i] : bytes1("a");
        }
        uint256 id = nft.mintTestNFT(SOURCE, 1, META, string(uri));
        require(bytes(nft.tokenURI(id)).length == 512, "maximum URI rejected");
        bytes memory oversized = bytes.concat(uri, bytes("a"));
        _reject(sha256("another source"), 1, META, string(oversized));
        (bool changed,) = address(nft)
            .call(abi.encodeWithSignature("setTokenURI(uint256,string)", id, "ipfs://new"));
        require(
            !changed && keccak256(bytes(nft.tokenURI(id))) == keccak256(uri), "metadata changed"
        );
    }

    function testRejectedReceiverRollsBackSourceAndCount() public {
        TestNFTReceiver receiver = new TestNFTReceiver();
        ArtFiHoodiTestNFT other = new ArtFiHoodiTestNFT(address(receiver), TASK);
        receiver.configure(true, false);
        (bool ok,) = address(receiver).call(abi.encodeCall(receiver.mint, (other, SOURCE)));
        require(!ok && other.mintedCount() == 0, "rejected recipient consumed count");
        require(other.tokenBySourceHash(SOURCE) == 0, "rejected recipient consumed source");
        receiver.configure(false, false);
        uint256 id = receiver.mint(other, SOURCE);
        require(other.ownerOf(id) == address(receiver), "valid retry did not mint");
    }

    function testIssuerReceiverCannotMintRecursively() public {
        TestNFTReceiver receiver = new TestNFTReceiver();
        ArtFiHoodiTestNFT other = new ArtFiHoodiTestNFT(address(receiver), TASK);
        receiver.configure(false, true);
        receiver.mint(other, SOURCE);
        require(receiver.reentryRejected() && other.mintedCount() == 1, "nested mint accepted");
        require(other.tokenBySourceHash(sha256("nested-source")) == 0, "nested source consumed");
    }

    function testTransferPreservesTestSourceAndMetadata() public {
        uint256 id = nft.mintTestNFT(SOURCE, 1, META, "ipfs://immutable");
        nft.transferFrom(address(this), address(0xBEEF), id);
        require(nft.ownerOf(id) == address(0xBEEF), "holder transfer blocked");
        ArtFiHoodiTestNFT.TestSource memory entry = nft.testSource(id);
        require(entry.sourceHash == SOURCE && entry.metadataHash == META, "transfer changed source");
        require(
            keccak256(bytes(nft.tokenURI(id))) == keccak256("ipfs://immutable"),
            "transfer changed URI"
        );
    }

    function testCannotReadInventedTokenAndSupportsERC721() public {
        (bool ok,) = address(nft).staticcall(abi.encodeCall(nft.testSource, (uint256(99))));
        require(!ok, "invented token accepted");
        require(nft.supportsInterface(0x80ac58cd), "missing ERC721");
        require(nft.supportsInterface(0x5b5e139f), "missing metadata interface");
    }

    function testFuzzUnsupportedKindNeverConsumesSource(uint8 kind) public {
        if (kind <= 1) return;
        _reject(SOURCE, kind, META, "ipfs://metadata");
        require(nft.tokenBySourceHash(SOURCE) == 0, "unsupported kind consumed source");
    }

    function _reject(bytes32 source, uint8 kind, bytes32 metadataHash, string memory uri) private {
        (bool ok,) =
            address(nft).call(abi.encodeCall(nft.mintTestNFT, (source, kind, metadataHash, uri)));
        require(!ok, "invalid mint accepted");
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
