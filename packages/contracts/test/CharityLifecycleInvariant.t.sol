// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiCharityEditions} from "../src/ArtFiCharityEditions.sol";

interface CharityLifecycleVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

/// @dev TEST_ONLY rejection fixture, not an institutional beneficiary or master-file store.
contract CharityRejectingRecipient {}

/// @dev Independent fixed-supply/holder ledger and monotonic evidence model.
contract CharityLifecycleHandler {
    CharityLifecycleVm private constant VM =
        CharityLifecycleVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address[3] private actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    ArtFiCharityEditions private editions;
    CharityRejectingRecipient private rejector;
    mapping(uint256 seriesIndex => mapping(uint256 actorIndex => uint256 units)) private holdings;
    bool[3] private soldOut;
    bool[3] private donated;
    bool private paused;
    uint256 private sequence;
    uint256 private pausedMoves;

    constructor() {
        editions =
            new ArtFiCharityEditions(address(this), address(this), address(this), address(this));
        rejector = new CharityRejectingRecipient();
        for (uint256 i; i < 3; ++i) {
            uint256 id =
                editions.createSeries(_artwork(i), _master(i), _metadata(i), actors[i], _uri(i));
            require(id == i + 1, "initial identity drift");
            holdings[i][i] = 100;
        }
    }

    function moveUnits(uint8 rawSeries, uint8 rawFrom, uint8 rawTo, uint8 rawAmount) public {
        uint256 i = uint256(rawSeries) % 3;
        uint256 from = uint256(rawFrom) % 3;
        uint256 to = (from + 1 + uint256(rawTo) % 2) % 3;
        uint256 available = holdings[i][from];
        if (available == 0) return;
        _move(i, from, to, 1 + uint256(rawAmount) % available);
    }

    function setPaused(bool next) public {
        if (next == paused) return;
        if (next) editions.pause();
        else editions.unpause();
        paused = next;
    }

    function recordSellout(uint8 rawSeries) public {
        uint256 i = uint256(rawSeries) % 3;
        bool eligible = !paused && !soldOut[i] && holdings[i][i] == 0;
        (bool ok,) = address(editions)
            .call(abi.encodeCall(editions.recordSellout, (i + 1, _saleEvidence(i))));
        require(ok == eligible, "sellout eligibility drift");
        if (ok) soldOut[i] = true;
    }

    function recordDonation(uint8 rawSeries) public {
        uint256 i = uint256(rawSeries) % 3;
        bool eligible = !paused && soldOut[i] && !donated[i];
        (bool ok,) = address(editions)
            .call(abi.encodeCall(editions.recordPhysicalDonation, (i + 1, _donationEvidence(i))));
        require(ok == eligible, "donation chronology drift");
        if (ok) donated[i] = true;
    }

    function rejectAdditionalSupply(uint8 rawSeries, bool burn) external {
        uint256 id = uint256(rawSeries) % 3 + 1;
        bytes memory input = burn
            ? abi.encodeWithSignature("burn(address,uint256,uint256)", actors[0], id, 1)
            : abi.encodeWithSignature(
                "mint(address,uint256,uint256,bytes)", actors[0], id, 1, bytes("")
            );
        (bool ok,) = address(editions).call(input);
        require(!ok, "additional mint or burn entry accepted");
    }

    function duplicateSeries(uint8 rawSeries, bool duplicateMaster) external {
        uint256 i = uint256(rawSeries) % 3;
        bytes32 fresh = keccak256(abi.encode("TEST_ONLY duplicate attempt", ++sequence));
        (bool ok,) = address(editions)
            .call(
                abi.encodeCall(
                    editions.createSeries,
                    (
                        duplicateMaster ? fresh : _artwork(i),
                        duplicateMaster ? _master(i) : fresh,
                        fresh,
                        actors[0],
                        "https://test-only.invalid/charity/duplicate"
                    )
                )
            );
        require(!ok, "duplicate identity minted twice");
        require(editions.tokenByArtworkId(fresh) == 0, "failed duplicate left artwork index");
        require(editions.tokenByMasterArtworkHash(fresh) == 0, "failed duplicate left master index");
    }

    function unauthorizedAction(uint8 rawSeries, uint8 rawAction) external {
        uint256 i = uint256(rawSeries) % 3;
        uint256 action = uint256(rawAction) % 3;
        bytes memory input = action == 0
            ? abi.encodeCall(editions.recordSellout, (i + 1, _saleEvidence(i)))
            : action == 1
                ? abi.encodeCall(editions.recordPhysicalDonation, (i + 1, _donationEvidence(i)))
                : abi.encodeCall(editions.pause, ());
        VM.prank(address(0xBAD));
        (bool ok,) = address(editions).call(input);
        require(!ok, "unprivileged recording or pause accepted");
    }

    function atomicRecipientFailure() public {
        if (paused) return;
        ArtFiCharityEditions.SeriesInput[] memory inputs = new ArtFiCharityEditions.SeriesInput[](2);
        for (uint256 n; n < 2; ++n) {
            bytes32 fresh = keccak256(abi.encode("TEST_ONLY reverted batch", ++sequence));
            inputs[n] = ArtFiCharityEditions.SeriesInput({
                artworkId: fresh,
                masterArtworkHash: keccak256(abi.encode(fresh, "master")),
                metadataHash: keccak256(abi.encode(fresh, "metadata")),
                distributionWallet: n == 0 ? actors[0] : address(rejector),
                metadataURI: "https://test-only.invalid/charity/reverted"
            });
        }
        (bool ok,) = address(editions).call(abi.encodeCall(editions.createSeriesBatch, (inputs)));
        require(!ok, "nonreceiver accepted batch");
        require(editions.seriesCount() == 3, "failed batch left partial series");
        for (uint256 n; n < 2; ++n) {
            require(editions.tokenByArtworkId(inputs[n].artworkId) == 0, "partial artwork index");
            require(
                editions.tokenByMasterArtworkHash(inputs[n].masterArtworkHash) == 0,
                "partial master index"
            );
        }
        require(
            editions.totalSupply(4) == 0 && editions.balanceOf(actors[0], 4) == 0, "partial supply"
        );
    }

    function advanceTime(uint32 rawSeconds) external {
        VM.warp(block.timestamp + 1 + uint256(rawSeconds) % 365 days);
    }

    function assertSupplyIdentityAndEvidence() public view {
        require(editions.seriesCount() == 3, "series count drift");
        require(editions.totalSupply() == 300, "collection supply drift");
        require(editions.paused() == paused, "pause model drift");
        for (uint256 i; i < 3; ++i) {
            uint256 id = i + 1;
            ArtFiCharityEditions.Series memory record_ = editions.series(id);
            require(editions.totalSupply(id) == 100, "per-artwork fixed supply drift");
            uint256 total;
            for (uint256 a; a < 3; ++a) {
                require(editions.balanceOf(actors[a], id) == holdings[i][a], "holder ledger drift");
                total += holdings[i][a];
            }
            require(total == 100, "unit conservation failed");
            require(
                record_.artworkId == _artwork(i) && record_.masterArtworkHash == _master(i),
                "asset identity drift"
            );
            require(record_.metadataHash == _metadata(i), "metadata commitment drift");
            require(record_.distributionWallet == actors[i], "original distributor drift");
            require(keccak256(bytes(editions.uri(id))) == keccak256(bytes(_uri(i))), "URI drift");
            require(editions.tokenByArtworkId(_artwork(i)) == id, "artwork index drift");
            require(editions.tokenByMasterArtworkHash(_master(i)) == id, "master index drift");
            require((record_.soldOutAt != 0) == soldOut[i], "sellout history drift");
            require(
                (record_.physicalDonationRecordedAt != 0) == donated[i], "donation history drift"
            );
            require(
                record_.selloutEvidenceHash == (soldOut[i] ? _saleEvidence(i) : bytes32(0)),
                "sale evidence drift"
            );
            require(
                record_.physicalDonationEvidenceHash
                    == (donated[i] ? _donationEvidence(i) : bytes32(0)),
                "donation evidence drift"
            );
            if (donated[i]) {
                require(
                    soldOut[i] && record_.physicalDonationRecordedAt >= record_.soldOutAt,
                    "donation preceded sellout"
                );
            }
        }
    }

    function finishValidSeries() external {
        // Even after arbitrary recorder/pause history, holders can still transfer while paused.
        setPaused(true);
        for (uint256 i; i < 3; ++i) {
            uint256 from;
            while (holdings[i][from] == 0) ++from;
            _move(i, from, (from + 1) % 3, 1);
        }
        require(pausedMoves >= 3, "paused holder transfers not exercised");
        setPaused(false);
        atomicRecipientFailure();
        for (uint8 i; i < 3; ++i) {
            uint256 remaining = holdings[i][i];
            if (remaining != 0) _move(i, i, (i + 1) % 3, remaining);
            if (!soldOut[i]) recordSellout(i);
            if (!donated[i]) recordDonation(i);
            require(soldOut[i] && donated[i], "valid evidence progression blocked");
        }
        assertSupplyIdentityAndEvidence();
    }

    function _move(uint256 i, uint256 from, uint256 to, uint256 amount) private {
        VM.prank(actors[from]);
        editions.safeTransferFrom(actors[from], actors[to], i + 1, amount, "");
        holdings[i][from] -= amount;
        holdings[i][to] += amount;
        if (paused) ++pausedMoves;
    }

    function _artwork(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("TEST_ONLY charity artwork", i));
    }

    function _master(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("TEST_ONLY master commitment", i));
    }

    function _metadata(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("TEST_ONLY metadata commitment", i));
    }

    function _saleEvidence(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("TEST_ONLY sale evidence, not external reconciliation", i));
    }

    function _donationEvidence(uint256 i) private pure returns (bytes32) {
        return keccak256(abi.encode("TEST_ONLY donation evidence, not CCHS acceptance", i));
    }

    function _uri(uint256 i) private pure returns (string memory) {
        return string(abi.encodePacked("https://test-only.invalid/charity/", bytes1(uint8(49 + i))));
    }
}

contract CharityLifecycleInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    CharityLifecycleHandler private handler;

    function setUp() public {
        handler = new CharityLifecycleHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.moveUnits.selector;
        selectors[1] = handler.setPaused.selector;
        selectors[2] = handler.recordSellout.selector;
        selectors[3] = handler.recordDonation.selector;
        selectors[4] = handler.rejectAdditionalSupply.selector;
        selectors[5] = handler.duplicateSeries.selector;
        selectors[6] = handler.unauthorizedAction.selector;
        selectors[7] = handler.atomicRecipientFailure.selector;
        selectors[8] = handler.advanceTime.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantFixedSupplyHolderTransfersAndMonotonicEvidence() public view {
        handler.assertSupplyIdentityAndEvidence();
    }

    function afterInvariant() public {
        handler.finishValidSeries();
    }
}
