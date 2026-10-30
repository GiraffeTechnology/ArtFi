// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ArtFiCharityEditions} from "../src/ArtFiCharityEditions.sol";

// Symbolic isolated fixtures only. No real artist, artwork, file or donation evidence.
function isolatedBatchInput(uint256 index, address recipient)
    pure
    returns (ArtFiCharityEditions.SeriesInput memory)
{
    return ArtFiCharityEditions.SeriesInput({
        artworkId: keccak256(abi.encode("TEST_ONLY_ATOMIC_ARTWORK", index)),
        masterArtworkHash: sha256(abi.encode("TEST_ONLY_ATOMIC_MASTER", index)),
        metadataHash: sha256(abi.encode("TEST_ONLY_ATOMIC_METADATA", index)),
        distributionWallet: recipient,
        metadataURI: "ipfs://TESTNET_NO_REAL_WORLD_VALUE_NO_LEGAL_EFFECT"
    });
}

abstract contract AtomicEditionReceiver is IERC1155Receiver {
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        virtual
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }
}

contract LateRejectingEditionReceiver is AtomicEditionReceiver {
    uint256 public calls;
    uint256 private immutable rejectedId;

    constructor(uint256 tokenId) {
        rejectedId = tokenId;
    }

    function onERC1155Received(address, address, uint256 id, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        calls++;
        require(id != rejectedId, "TEST_ONLY_LATE_REJECTION");
        return IERC1155Receiver.onERC1155Received.selector;
    }
}

contract ReentrantEditionReceiver is AtomicEditionReceiver {
    ArtFiCharityEditions private immutable editions;
    bool private immutable nestedBatch;
    bool public attempted;
    bool public reentrySucceeded;

    constructor(ArtFiCharityEditions target, bool batch) {
        editions = target;
        nestedBatch = batch;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (!attempted) {
            attempted = true;
            ArtFiCharityEditions.SeriesInput memory input = isolatedBatchInput(9000, address(this));
            if (nestedBatch) {
                ArtFiCharityEditions.SeriesInput[] memory inputs =
                    new ArtFiCharityEditions.SeriesInput[](1);
                inputs[0] = input;
                (reentrySucceeded,) =
                    address(editions).call(abi.encodeCall(editions.createSeriesBatch, (inputs)));
            } else {
                (reentrySucceeded,) = address(editions)
                    .call(
                        abi.encodeCall(
                            editions.createSeries,
                            (
                                input.artworkId,
                                input.masterArtworkHash,
                                input.metadataHash,
                                input.distributionWallet,
                                input.metadataURI
                            )
                        )
                    );
            }
        }
        return IERC1155Receiver.onERC1155Received.selector;
    }
}

contract ControlChangingEditionReceiver is AtomicEditionReceiver {
    ArtFiCharityEditions private immutable editions;
    address private immutable creator;
    bool private immutable pauses;
    uint256 public calls;

    constructor(ArtFiCharityEditions target, address originalCreator, bool pauseInstead) {
        editions = target;
        creator = originalCreator;
        pauses = pauseInstead;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata)
        external
        override
        returns (bytes4)
    {
        calls++;
        if (pauses) editions.pause();
        else editions.revokeRole(editions.SERIES_CREATOR_ROLE(), creator);
        return IERC1155Receiver.onERC1155Received.selector;
    }
}

contract UnprivilegedBatchCaller {
    function create(ArtFiCharityEditions editions) external {
        ArtFiCharityEditions.SeriesInput[] memory inputs = new ArtFiCharityEditions.SeriesInput[](1);
        inputs[0] = isolatedBatchInput(0, address(0xBEEF));
        editions.createSeriesBatch(inputs);
    }
}

abstract contract CharityBatchHarness is AtomicEditionReceiver {
    ArtFiCharityEditions internal editions;

    function setUp() public {
        editions =
            new ArtFiCharityEditions(address(this), address(this), address(this), address(this));
    }

    function _assertReentrancyBlocked(bool outerBatch, bool innerBatch) internal {
        ReentrantEditionReceiver receiver = new ReentrantEditionReceiver(editions, innerBatch);
        editions.grantRole(editions.SERIES_CREATOR_ROLE(), address(receiver));
        if (outerBatch) editions.createSeriesBatch(_inputs(2, address(receiver)));
        else _single(isolatedBatchInput(0, address(receiver)));
        require(receiver.attempted() && !receiver.reentrySucceeded(), "creation reentry succeeded");
        require(editions.seriesCount() == (outerBatch ? 2 : 1), "reentry consumed extra identity");
        require(
            editions.tokenByArtworkId(isolatedBatchInput(9000, address(receiver)).artworkId) == 0,
            "nested mint persisted"
        );
    }

    function _assertCreated(ArtFiCharityEditions.SeriesInput[] memory inputs) internal {
        uint256[] memory ids = editions.createSeriesBatch(inputs);
        require(
            ids.length == inputs.length && editions.seriesCount() == inputs.length, "batch count"
        );
        require(editions.totalSupply() == inputs.length * 100, "aggregate supply");
        for (uint256 i; i < inputs.length; i++) {
            require(ids[i] == i + 1, "series order");
            require(editions.totalSupply(ids[i]) == 100, "fixed per-series supply");
            require(
                editions.balanceOf(inputs[i].distributionWallet, ids[i]) == 100,
                "recipient quantity"
            );
            ArtFiCharityEditions.Series memory value = editions.series(ids[i]);
            require(value.artworkId == inputs[i].artworkId, "artwork binding");
            require(value.masterArtworkHash == inputs[i].masterArtworkHash, "master binding");
            require(value.metadataHash == inputs[i].metadataHash, "metadata binding");
            require(value.distributionWallet == inputs[i].distributionWallet, "recipient binding");
            require(
                keccak256(bytes(value.metadataURI)) == keccak256(bytes(inputs[i].metadataURI)),
                "URI binding"
            );
            require(editions.tokenByArtworkId(inputs[i].artworkId) == ids[i], "artwork index");
            require(
                editions.tokenByMasterArtworkHash(inputs[i].masterArtworkHash) == ids[i],
                "master index"
            );
        }
    }

    function _requireBatchFailure(
        ArtFiCharityEditions.SeriesInput[] memory inputs,
        uint256 previousCount
    ) internal {
        (bool ok,) = address(editions).call(abi.encodeCall(editions.createSeriesBatch, (inputs)));
        require(!ok, "invalid batch accepted");
        require(editions.seriesCount() == previousCount, "series prefix survived");
        require(editions.totalSupply() == previousCount * 100, "mint prefix survived");
        ArtFiCharityEditions.SeriesInput memory original = isolatedBatchInput(1000, address(this));
        for (uint256 i; i < inputs.length; i++) {
            uint256 artwork = editions.tokenByArtworkId(inputs[i].artworkId);
            uint256 master = editions.tokenByMasterArtworkHash(inputs[i].masterArtworkHash);
            require(
                artwork
                    == (previousCount != 0 && inputs[i].artworkId == original.artworkId ? 1 : 0),
                "new artwork index survived"
            );
            require(
                master
                    == (previousCount != 0
                            && inputs[i].masterArtworkHash == original.masterArtworkHash
                            ? 1
                            : 0),
                "new master index survived"
            );
        }
    }

    function _inputs(uint256 count, address recipient)
        internal
        pure
        returns (ArtFiCharityEditions.SeriesInput[] memory inputs)
    {
        inputs = new ArtFiCharityEditions.SeriesInput[](count);
        for (uint256 i; i < count; i++) {
            inputs[i] = isolatedBatchInput(i, recipient);
        }
    }

    function _single(ArtFiCharityEditions.SeriesInput memory input) internal returns (uint256) {
        return editions.createSeries(
            input.artworkId,
            input.masterArtworkHash,
            input.metadataHash,
            input.distributionWallet,
            input.metadataURI
        );
    }

    function _uri(uint256 length) internal pure returns (string memory) {
        bytes memory value = new bytes(length);
        bytes memory prefix = bytes("ipfs://");
        for (uint256 i; i < length; i++) {
            value[i] = i < prefix.length ? prefix[i] : bytes1("a");
        }
        return string(value);
    }
}

contract CharityEditionBatchTest is CharityBatchHarness {
    function testCreatesThirteenSeriesInOneCall() public {
        _assertCreated(_inputs(13, address(this)));
        require(editions.totalSupply() == 1300, "13-series total");
    }

    function testCreatesThirtySevenSeriesInOneCall() public {
        _assertCreated(_inputs(37, address(this)));
        require(editions.totalSupply() == 3700, "37-series total");
    }

    function testRejectsEmptyBatch() public {
        _requireBatchFailure(_inputs(0, address(this)), 0);
    }

    function testRejectsOversizedBatch() public {
        _requireBatchFailure(_inputs(38, address(this)), 0);
    }

    function testLateDuplicateArtworkRollsBackWholeBatch() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(13, address(this));
        inputs[12].artworkId = inputs[0].artworkId;
        _requireBatchFailure(inputs, 0);
    }

    function testLateDuplicateMasterRollsBackWholeBatch() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(13, address(this));
        inputs[12].masterArtworkHash = inputs[0].masterArtworkHash;
        _requireBatchFailure(inputs, 0);
    }

    function testExistingArtworkPreservesOriginalSeriesAndRejectsEntireBatch() public {
        ArtFiCharityEditions.SeriesInput memory original = isolatedBatchInput(1000, address(this));
        _single(original);
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].artworkId = original.artworkId;
        _requireBatchFailure(inputs, 1);
        require(
            editions.series(1).metadataHash == original.metadataHash, "existing metadata changed"
        );
        require(editions.balanceOf(address(this), 1) == 100, "existing balance changed");
    }

    function testExistingMasterPreservesOriginalSeriesAndRejectsEntireBatch() public {
        ArtFiCharityEditions.SeriesInput memory original = isolatedBatchInput(1000, address(this));
        _single(original);
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].masterArtworkHash = original.masterArtworkHash;
        _requireBatchFailure(inputs, 1);
        require(editions.series(1).artworkId == original.artworkId, "existing identity changed");
    }

    function testZeroArtworkInLastEntryRollsBackAll() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].artworkId = bytes32(0);
        _requireBatchFailure(inputs, 0);
    }

    function testZeroMasterInLastEntryRollsBackAll() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].masterArtworkHash = bytes32(0);
        _requireBatchFailure(inputs, 0);
    }

    function testZeroMetadataInLastEntryRollsBackAll() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].metadataHash = bytes32(0);
        _requireBatchFailure(inputs, 0);
    }

    function testZeroRecipientInLastEntryRollsBackAll() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].distributionWallet = address(0);
        _requireBatchFailure(inputs, 0);
    }

    function testInvalidUriInLastEntryRollsBackAll() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].metadataURI = "http://TEST_ONLY_INVALID";
        _requireBatchFailure(inputs, 0);
    }

    function testOverlongUriInLastEntryRollsBackAll() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(3, address(this));
        inputs[2].metadataURI = _uri(513);
        _requireBatchFailure(inputs, 0);
    }

    function testMaximumUriLengthRetainsFixedSupply() public {
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(2, address(this));
        inputs[1].metadataURI = _uri(512);
        _assertCreated(inputs);
    }

    function testUnprivilegedCallerCannotCreateBatch() public {
        UnprivilegedBatchCaller caller = new UnprivilegedBatchCaller();
        (bool ok,) = address(caller).call(abi.encodeCall(caller.create, (editions)));
        require(!ok, "unprivileged batch accepted");
        require(
            editions.seriesCount() == 0 && editions.totalSupply() == 0, "role failure mutated state"
        );
    }

    function testPausedContractRejectsWholeBatch() public {
        editions.pause();
        _requireBatchFailure(_inputs(3, address(this)), 0);
    }

    function testKnownRevertedBatchDoesNotConsumeSeriesIds() public {
        ArtFiCharityEditions.SeriesInput[] memory invalid = _inputs(3, address(this));
        invalid[2].metadataHash = bytes32(0);
        _requireBatchFailure(invalid, 0);
        _assertCreated(_inputs(3, address(this)));
    }

    function testFuzzBoundedBatchFixedSupply(uint8 rawCount) public {
        uint256 count = uint256(rawCount) % 37 + 1;
        _assertCreated(_inputs(count, address(this)));
    }

    function testFuzzInvalidEntryRevertsWholeBatch(uint8 rawCount, uint8 rawIndex) public {
        uint256 count = uint256(rawCount) % 37 + 1;
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(count, address(this));
        inputs[uint256(rawIndex) % count].metadataHash = bytes32(0);
        _requireBatchFailure(inputs, 0);
    }

    function testBatchBoundDoesNotCapCollectionSeriesCount() public {
        editions.createSeriesBatch(_inputs(37, address(this)));
        ArtFiCharityEditions.SeriesInput[] memory next = new ArtFiCharityEditions.SeriesInput[](1);
        next[0] = isolatedBatchInput(37, address(this));
        uint256[] memory ids = editions.createSeriesBatch(next);
        require(ids[0] == 38, "batch bound became collection cap");
        require(_single(isolatedBatchInput(38, address(this))) == 39, "single entry capped");
        require(editions.seriesCount() == 39 && editions.totalSupply() == 3900, "cumulative supply");
    }
}

contract CharityEditionBatchCallbackTest is CharityBatchHarness {
    function testLateReceiverFailureRollsBackCollectionAndReceiverState() public {
        _single(isolatedBatchInput(1000, address(this)));
        LateRejectingEditionReceiver receiver = new LateRejectingEditionReceiver(3);
        _requireBatchFailure(_inputs(3, address(receiver)), 1);
        require(receiver.calls() == 0, "receiver side effects survived revert");
        require(editions.balanceOf(address(receiver), 2) == 0, "prefix balance survived");
    }

    function testBatchCallbackCannotReenterSingleCreation() public {
        _assertReentrancyBlocked(true, false);
    }

    function testBatchCallbackCannotReenterBatchCreation() public {
        _assertReentrancyBlocked(true, true);
    }

    function testSingleCallbackCannotReenterBatchCreation() public {
        _assertReentrancyBlocked(false, true);
    }

    function testSingleCallbackCannotReenterSingleCreation() public {
        _assertReentrancyBlocked(false, false);
    }

    function testPauseDuringLastReceiverCallbackRevertsWholeBatch() public {
        ControlChangingEditionReceiver receiver =
            new ControlChangingEditionReceiver(editions, address(this), true);
        editions.grantRole(editions.PAUSER_ROLE(), address(receiver));
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(2, address(this));
        inputs[1].distributionWallet = address(receiver);
        _requireBatchFailure(inputs, 0);
        require(!editions.paused(), "callback pause survived failed batch");
        require(receiver.calls() == 0, "callback count survived failed batch");
    }

    function testCreatorRevocationDuringLastCallbackRevertsWholeBatch() public {
        ControlChangingEditionReceiver receiver =
            new ControlChangingEditionReceiver(editions, address(this), false);
        editions.grantRole(editions.DEFAULT_ADMIN_ROLE(), address(receiver));
        ArtFiCharityEditions.SeriesInput[] memory inputs = _inputs(2, address(this));
        inputs[1].distributionWallet = address(receiver);
        _requireBatchFailure(inputs, 0);
        require(
            editions.hasRole(editions.SERIES_CREATOR_ROLE(), address(this)),
            "callback revocation survived"
        );
        require(receiver.calls() == 0, "callback count survived");
    }

    function testBatchTokensRemainTransferableWhilePaused() public {
        editions.createSeriesBatch(_inputs(2, address(this)));
        editions.pause();
        editions.safeTransferFrom(address(this), address(0xBEEF), 1, 1, "");
        require(editions.balanceOf(address(0xBEEF), 1) == 1, "pause froze holder");
        require(editions.totalSupply(1) == 100, "pause changed supply");
    }
}
