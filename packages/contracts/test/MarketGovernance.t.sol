// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ArtFiDAOActions, IArtFiBuyoutPriceVerifier} from "../src/ArtFiDAOActions.sol";
import {ArtFiGovernor} from "../src/ArtFiGovernor.sol";
import {ArtFiGovernanceBootstrap} from "../src/ArtFiGovernanceBootstrap.sol";
import {ArtFiMarket} from "../src/ArtFiMarket.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {FractionalToken} from "../src/FractionalToken.sol";

interface Stage4Vm {
    function prank(address sender) external;
    function roll(uint256 blockNumber) external;
    function warp(uint256 timestamp) external;
}

contract MarketToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract GovernanceNFT is ERC721 {
    constructor() ERC721("Governed RWA", "GRWA") {}

    function mint(address recipient, uint256 tokenId) external {
        _mint(recipient, tokenId);
    }
}

contract AcceptingBuyoutVerifier is IArtFiBuyoutPriceVerifier {
    bool public accept = true;

    function setAccept(bool value) external {
        accept = value;
    }

    function verifyBuyoutPrice(address, uint256, uint48, uint48, uint8, uint32, bytes32)
        external
        view
        returns (bool)
    {
        return accept;
    }
}

contract MarketGovernanceTest {
    Stage4Vm private constant VM =
        Stage4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BUYER_A = address(0xA11CE);
    address private constant BUYER_B = address(0xB0B);

    ArtFiMarket private market;
    MarketToken private asset;
    MarketToken private payment;

    function setUp() public {
        market = new ArtFiMarket(address(this), address(this), address(this));
        asset = new MarketToken("Fraction", "FRC");
        payment = new MarketToken("Test USD", "TUSD");
        market.setTokenPermission(address(asset), true, false);
        market.setTokenPermission(address(payment), false, true);
        market.setPilotCap(BUYER_A, address(payment), 1_000_000);
        market.setPilotCap(BUYER_B, address(payment), 1_000_000);
        asset.mint(address(this), 1_000_000);
        payment.mint(BUYER_A, 1_000_000);
        payment.mint(BUYER_B, 1_000_000);
        asset.approve(address(market), type(uint256).max);
        VM.prank(BUYER_A);
        payment.approve(address(market), type(uint256).max);
        VM.prank(BUYER_B);
        payment.approve(address(market), type(uint256).max);
    }

    /// `PRD.md` §4.2.2 removed the pull at listing time from the fixed-price path. Creating an
    /// escrowed fixed-price listing is therefore refused here; that path is `fillIntent`, covered
    /// in `FractionSaleIntent.t.sol`. The escrow this test used to assert is what the ruling closed.
    function testFixedPriceListingIsRefusedBecauseItSettlesBySignature() public {
        uint256 sellerBefore = asset.balanceOf(address(this));
        (bool ok, bytes memory reason) = address(market)
            .call(
                abi.encodeCall(
                    market.createListing,
                    (
                        keccak256("fixed"),
                        asset,
                        payment,
                        100,
                        3,
                        uint48(block.timestamp),
                        uint48(block.timestamp + 10),
                        ArtFiMarket.ListingKind.FixedPrice
                    )
                )
            );
        require(!ok, "an escrowed fixed-price listing was created");
        require(
            _revertSelector(reason) == ArtFiMarket.FixedPriceSettlesBySignature.selector,
            "fixed-price listing did not fail closed"
        );
        require(asset.balanceOf(address(this)) == sellerBefore, "the refused listing took tokens");
        require(asset.balanceOf(address(market)) == 0, "the market escrowed on a refused listing");
    }

    /// The auction path keeps escrow, which §4.2.2 retains, so the pilot cap is checked there.
    function testPilotCapFailsClosed() public {
        market.setPilotCap(BUYER_A, address(payment), 10);
        uint256 listingId = market.createAuctionListing(
            keccak256("pilot-cap"),
            asset,
            payment,
            100,
            12,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            12,
            1,
            2,
            5
        );
        VM.prank(BUYER_A);
        (bool ok,) = address(market).call(abi.encodeCall(market.placeBid, (listingId, 12)));
        require(!ok, "pilot cap bypassed");
    }

    function testAuctionRefundExpiryAndSettlement() public {
        uint256 listingId = market.createAuctionListing(
            keccak256("auction"),
            asset,
            payment,
            100,
            100,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            100,
            1,
            2,
            5
        );
        VM.prank(BUYER_A);
        market.placeBid(listingId, 120);
        VM.prank(BUYER_B);
        market.placeBid(listingId, 150);
        require(market.credits(BUYER_A, address(payment)) == 120, "outbid refund credit");
        VM.warp(block.timestamp + 11);
        market.settleAuction(listingId);
        require(asset.balanceOf(BUYER_B) == 100, "winner asset");
        require(market.credits(address(this), address(payment)) == 150, "auction seller credit");
        VM.prank(BUYER_A);
        market.withdrawCredit(payment);
        require(payment.balanceOf(BUYER_A) == 1_000_000, "outbid refund");
    }

    function testLegacyAuctionListingPreservesAuditedDefaults() public {
        uint48 end = uint48(block.timestamp + 1 hours);
        uint256 listingId = market.createListing(
            keccak256("legacy-auction"),
            asset,
            payment,
            100,
            100,
            uint48(block.timestamp),
            end,
            ArtFiMarket.ListingKind.Auction
        );
        (
            uint256 reservePrice,
            uint256 minimumBidIncrement,
            uint48 storedEnd,
            uint48 extensionWindow,
            uint48 extensionDuration
        ) = market.auctionTerms(listingId);
        require(reservePrice == 100, "legacy reserve changed");
        require(minimumBidIncrement == 1, "legacy increment changed");
        require(storedEnd == end, "legacy end changed");
        require(
            extensionWindow == market.LEGACY_AUCTION_EXTENSION_WINDOW(),
            "legacy extension window changed"
        );
        require(
            extensionDuration == market.LEGACY_AUCTION_EXTENSION_DURATION(),
            "legacy extension duration changed"
        );

        VM.prank(BUYER_A);
        market.placeBid(listingId, 100);
        VM.prank(BUYER_B);
        market.placeBid(listingId, 101);

        // The legacy auction defaults above are unchanged by §4.2.2. What the same call no longer
        // does is create an escrowed fixed-price listing.
        (bool fixedOk, bytes memory fixedRevert) = address(market)
            .call(
                abi.encodeCall(
                    market.createListing,
                    (
                        keccak256("legacy-fixed-defaults"),
                        asset,
                        payment,
                        1,
                        1,
                        uint48(block.timestamp),
                        uint48(block.timestamp + 1 hours),
                        ArtFiMarket.ListingKind.FixedPrice
                    )
                )
            );
        require(!fixedOk, "the legacy fixed-price path still escrows");
        require(
            _revertSelector(fixedRevert) == ArtFiMarket.FixedPriceSettlesBySignature.selector,
            "legacy fixed-price path did not fail closed"
        );
    }

    function testLegacyAuctionLateBidExtendsAndOriginalEndCannotSettle() public {
        uint48 originalEnd = uint48(block.timestamp + 100);
        uint256 listingId = market.createListing(
            keccak256("legacy-auction-extension"),
            asset,
            payment,
            100,
            100,
            uint48(block.timestamp),
            originalEnd,
            ArtFiMarket.ListingKind.Auction
        );
        (,,, uint48 extensionWindow, uint48 extensionDuration) = market.auctionTerms(listingId);
        require(extensionWindow == 100, "short legacy window not capped to auction duration");
        require(
            extensionDuration == market.LEGACY_AUCTION_EXTENSION_DURATION(),
            "legacy extension duration changed"
        );

        VM.warp(originalEnd - 1);
        VM.prank(BUYER_A);
        market.placeBid(listingId, 100);

        (,, uint48 extendedEnd,,) = market.auctionTerms(listingId);
        require(extendedEnd == originalEnd + extensionDuration, "legacy late bid did not extend");
        VM.warp(originalEnd);
        (bool settledAtOriginalEnd,) =
            address(market).call(abi.encodeCall(market.settleAuction, (listingId)));
        require(!settledAtOriginalEnd, "legacy auction settled at original end");

        VM.warp(extendedEnd);
        market.settleAuction(listingId);
        require(asset.balanceOf(BUYER_A) == 100, "legacy extended winner missing asset");
        require(market.credits(address(this), address(payment)) == 100, "legacy seller credit");
    }

    function testLegacyListingsGetterSelectorAndOutputOrderRemainCompatible() public {
        uint48 startsAt = uint48(block.timestamp);
        uint48 endsAt = startsAt + 1 days;
        uint256 listingId = market.createListing(
            keccak256("legacy-getter"),
            asset,
            payment,
            10,
            7,
            startsAt,
            endsAt,
            ArtFiMarket.ListingKind.Auction
        );
        require(
            ArtFiMarket.listings.selector == bytes4(keccak256("listings(uint256)")),
            "legacy getter selector changed"
        );
        (bool ok, bytes memory returndata) =
            address(market).staticcall(abi.encodeCall(market.listings, (listingId)));
        require(ok, "legacy getter call failed");
        (
            address seller,
            address assetToken,
            address paymentToken,
            uint256 amountRemaining,
            uint256 unitPrice,
            uint48 storedStartsAt,
            uint48 storedEndsAt,
            ArtFiMarket.ListingKind kind,
            ArtFiMarket.State state,
            address highestBidder,
            uint256 highestBid
        ) = abi.decode(
            returndata,
            (
                address,
                address,
                address,
                uint256,
                uint256,
                uint48,
                uint48,
                ArtFiMarket.ListingKind,
                ArtFiMarket.State,
                address,
                uint256
            )
        );
        require(seller == address(this), "legacy seller position");
        require(assetToken == address(asset), "legacy asset position");
        require(paymentToken == address(payment), "legacy payment position");
        require(amountRemaining == 10 && unitPrice == 7, "legacy amount/price positions");
        require(storedStartsAt == startsAt && storedEndsAt == endsAt, "legacy time positions");
        require(kind == ArtFiMarket.ListingKind.Auction, "legacy kind position");
        require(state == ArtFiMarket.State.Active, "legacy state position");
        require(highestBidder == address(0) && highestBid == 0, "legacy bid positions");
    }

    function testAuctionReserveNotMetRefundsBidAndReturnsAsset() public {
        uint256 sellerAssetBefore = asset.balanceOf(address(this));
        uint256 listingId = market.createAuctionListing(
            keccak256("auction-reserve"),
            asset,
            payment,
            100,
            100,
            uint48(block.timestamp),
            uint48(block.timestamp + 100),
            200,
            10,
            10,
            30
        );

        VM.prank(BUYER_A);
        market.placeBid(listingId, 150);
        VM.warp(block.timestamp + 101);
        market.settleAuction(listingId);

        require(asset.balanceOf(address(this)) == sellerAssetBefore, "reserve returned asset");
        require(asset.balanceOf(BUYER_A) == 0, "sub-reserve bidder received asset");
        require(market.credits(address(this), address(payment)) == 0, "seller received bid");
        require(market.credits(BUYER_A, address(payment)) == 150, "bid refund missing");
        VM.prank(BUYER_A);
        market.withdrawCredit(payment);
        require(payment.balanceOf(BUYER_A) == 1_000_000, "reserve refund incomplete");
    }

    function testAuctionMinimumIncrementRejectsBelowAndAcceptsExactBoundary() public {
        uint256 listingId = _createAuction(
            keccak256("auction-increment"), 100, 100, 25, uint48(block.timestamp + 100), 10, 30
        );
        VM.prank(BUYER_A);
        market.placeBid(listingId, 100);

        VM.prank(BUYER_B);
        (bool belowIncrement,) =
            address(market).call(abi.encodeCall(market.placeBid, (listingId, 124)));
        require(!belowIncrement, "sub-increment bid accepted");
        require(payment.balanceOf(BUYER_B) == 1_000_000, "rejected bid charged buyer");

        VM.prank(BUYER_B);
        market.placeBid(listingId, 125);
        require(market.credits(BUYER_A, address(payment)) == 100, "outbid refund missing");
    }

    function testFuzzAuctionMinimumIncrementBoundary(uint96 rawIncrement) public {
        // Keep the exact-boundary bid within BUYER_B's finite 1,000,000 pilot cap and balance.
        uint256 increment = uint256(rawIncrement) % 999_900 + 1;
        uint256 listingId = _createAuction(
            keccak256(abi.encode("auction-increment-fuzz", rawIncrement)),
            100,
            100,
            increment,
            uint48(block.timestamp + 100),
            10,
            30
        );
        VM.prank(BUYER_A);
        market.placeBid(listingId, 100);

        VM.prank(BUYER_B);
        (bool belowIncrement,) =
            address(market).call(abi.encodeCall(market.placeBid, (listingId, 100 + increment - 1)));
        require(!belowIncrement, "fuzz sub-increment accepted");

        VM.prank(BUYER_B);
        market.placeBid(listingId, 100 + increment);
    }

    function testLateBidExtendsAuctionAndOriginalEndCannotSettle() public {
        uint48 originalEnd = uint48(block.timestamp + 100);
        uint256 listingId =
            _createAuction(keccak256("auction-extension"), 100, 100, 10, originalEnd, 10, 30);
        VM.warp(originalEnd - 5);
        VM.prank(BUYER_A);
        market.placeBid(listingId, 100);

        (,, uint48 extendedEnd,,) = market.auctionTerms(listingId);
        require(extendedEnd == originalEnd + 30, "late bid did not extend auction");
        VM.warp(originalEnd);
        (bool settledAtOriginalEnd,) =
            address(market).call(abi.encodeCall(market.settleAuction, (listingId)));
        require(!settledAtOriginalEnd, "auction settled at original end");

        VM.warp(extendedEnd);
        market.settleAuction(listingId);
        require(asset.balanceOf(BUYER_A) == 100, "extended auction winner missing asset");
    }

    function testLateBidExtensionOverflowFailsWithStableError() public {
        uint48 end = type(uint48).max - 2;
        uint256 listingId =
            _createAuction(keccak256("auction-extension-overflow"), 100, 100, 10, end, 10, 30);
        VM.warp(uint256(end) - 5);
        VM.prank(BUYER_A);
        (bool ok, bytes memory revertData) =
            address(market).call(abi.encodeCall(market.placeBid, (listingId, 100)));
        require(!ok, "overflowing extension accepted");
        require(
            _revertSelector(revertData) == ArtFiMarket.AuctionEndOverflow.selector,
            "overflow did not use stable error"
        );
        require(payment.balanceOf(BUYER_A) == 1_000_000, "overflowing bid charged buyer");
        require(market.credits(BUYER_A, address(payment)) == 0, "overflow created refund credit");
    }

    function testRefundDoesNotResetCumulativePilotUsage() public {
        market.setPilotCap(BUYER_A, address(payment), 150);
        uint256 listingId = _createAuction(
            keccak256("cumulative-pilot-reserve"),
            100,
            200,
            10,
            uint48(block.timestamp + 100),
            10,
            30
        );
        VM.prank(BUYER_A);
        market.placeBid(listingId, 150);
        VM.warp(block.timestamp + 101);
        market.settleAuction(listingId);
        VM.prank(BUYER_A);
        market.withdrawCredit(payment);
        require(market.pilotPaymentUsed(BUYER_A, address(payment)) == 150, "pilot usage reset");

        uint256 secondListing = market.createListing(
            keccak256("cumulative-pilot-second"),
            asset,
            payment,
            1,
            1,
            uint48(block.timestamp),
            uint48(block.timestamp + 100),
            ArtFiMarket.ListingKind.Auction
        );
        VM.prank(BUYER_A);
        (bool secondBid,) =
            address(market).call(abi.encodeCall(market.placeBid, (secondListing, 1)));
        require(!secondBid, "cumulative pilot cap reset after refund");
    }

    function testPausedSellerCanCancelAuctionAndRecoverEscrow() public {
        uint256 sellerAssetBefore = asset.balanceOf(address(this));
        uint256 listingId = _createAuction(
            keccak256("paused-cancel"), 100, 100, 10, uint48(block.timestamp + 100), 10, 30
        );
        market.pause();

        VM.prank(BUYER_A);
        (bool unauthorized,) =
            address(market).call(abi.encodeCall(market.cancelListing, (listingId)));
        require(!unauthorized, "non-seller cancelled paused auction");

        market.cancelListing(listingId);
        require(asset.balanceOf(address(this)) == sellerAssetBefore, "paused escrow not returned");
        (bool cancelledTwice,) =
            address(market).call(abi.encodeCall(market.cancelListing, (listingId)));
        require(!cancelledTwice, "paused listing cancelled twice");
    }

    function testPausedAuctionWithBidCannotBeCancelledButCanSettle() public {
        uint256 listingId = _createAuction(
            keccak256("paused-active-bid"), 100, 100, 10, uint48(block.timestamp + 100), 10, 30
        );
        VM.prank(BUYER_A);
        market.placeBid(listingId, 100);
        market.pause();

        (bool cancelled,) = address(market).call(abi.encodeCall(market.cancelListing, (listingId)));
        require(!cancelled, "active bidder lost escrow protection");
        VM.warp(block.timestamp + 101);
        market.settleAuction(listingId);
        require(asset.balanceOf(BUYER_A) == 100, "paused settlement trapped asset");
        require(market.credits(address(this), address(payment)) == 100, "seller credit missing");
    }

    function testAuctionConfigurationFailsClosed() public {
        uint48 end = uint48(block.timestamp + 100);
        (bool reserveBelowOpening,) = address(market)
            .call(
                abi.encodeCall(
                    market.createAuctionListing,
                    (
                        keccak256("bad-reserve"),
                        asset,
                        payment,
                        100,
                        100,
                        uint48(block.timestamp),
                        end,
                        99,
                        10,
                        10,
                        30
                    )
                )
            );
        require(!reserveBelowOpening, "reserve below opening accepted");

        (bool zeroIncrement,) = address(market)
            .call(
                abi.encodeCall(
                    market.createAuctionListing,
                    (
                        keccak256("zero-increment"),
                        asset,
                        payment,
                        100,
                        100,
                        uint48(block.timestamp),
                        end,
                        100,
                        0,
                        10,
                        30
                    )
                )
            );
        require(!zeroIncrement, "zero increment accepted");

        (bool missingExtension,) = address(market)
            .call(
                abi.encodeCall(
                    market.createAuctionListing,
                    (
                        keccak256("missing-extension"),
                        asset,
                        payment,
                        100,
                        100,
                        uint48(block.timestamp),
                        end,
                        100,
                        10,
                        0,
                        0
                    )
                )
            );
        require(!missingExtension, "missing extension accepted");
    }

    function testAuctionRequestReplayAndAllTermsConflict() public {
        bytes32 requestId = keccak256("auction-terms-replay");
        uint48 end = uint48(block.timestamp + 100);
        uint256 sellerBalanceBefore = asset.balanceOf(address(this));
        uint256 first = _createAuction(requestId, 100, 150, 10, end, 10, 30);
        uint256 replay = market.createAuctionListing(
            requestId, asset, payment, 100, 100, uint48(block.timestamp), end, 150, 10, 10, 30
        );
        require(first == replay, "auction replay changed id");
        require(
            asset.balanceOf(address(this)) == sellerBalanceBefore - 100,
            "auction replay pulled escrow twice"
        );

        require(!_tryAuctionTerms(requestId, end, 151, 10, 10, 30), "reserve conflict accepted");
        require(!_tryAuctionTerms(requestId, end, 150, 11, 10, 30), "increment conflict accepted");
        require(!_tryAuctionTerms(requestId, end, 150, 10, 11, 30), "window conflict accepted");
        require(!_tryAuctionTerms(requestId, end, 150, 10, 10, 31), "duration conflict accepted");
    }

    function testListingRequestReplayAndConflict() public {
        bytes32 requestId = keccak256("replay");
        uint48 start = uint48(block.timestamp);
        uint48 end = uint48(block.timestamp + 10);
        uint256 first = market.createListing(
            requestId, asset, payment, 20, 2, start, end, ArtFiMarket.ListingKind.Auction
        );
        uint256 replay = market.createListing(
            requestId, asset, payment, 20, 2, start, end, ArtFiMarket.ListingKind.Auction
        );
        require(first == replay, "listing replay changed id");
        (bool ok,) = address(market)
            .call(
                abi.encodeCall(
                    market.createListing,
                    (requestId, asset, payment, 21, 2, start, end, ArtFiMarket.ListingKind.Auction)
                )
            );
        require(!ok, "listing conflict accepted");
    }

    function testOfferingSuccessClaimAndUnsoldReturn() public {
        uint256 sellerBefore = asset.balanceOf(address(this));
        uint256 offeringId = market.createOffering(
            keccak256("offering-success"),
            asset,
            payment,
            1_000,
            500,
            1_000,
            uint48(block.timestamp),
            uint48(block.timestamp + 10)
        );
        VM.prank(BUYER_A);
        market.contribute(offeringId, 600);
        VM.warp(block.timestamp + 11);
        market.finalizeOffering(offeringId);
        VM.prank(BUYER_A);
        market.claimOffering(offeringId);
        require(asset.balanceOf(BUYER_A) == 600, "offering allocation");
        require(asset.balanceOf(address(this)) == sellerBefore - 600, "unsold return");
        require(market.credits(address(this), address(payment)) == 600, "offering proceeds");
    }

    function testOfferingFailureRefund() public {
        uint256 offeringId = market.createOffering(
            keccak256("offering-failure"),
            asset,
            payment,
            1_000,
            500,
            1_000,
            uint48(block.timestamp),
            uint48(block.timestamp + 10)
        );
        VM.prank(BUYER_A);
        market.contribute(offeringId, 100);
        VM.warp(block.timestamp + 11);
        market.finalizeOffering(offeringId);
        VM.prank(BUYER_A);
        market.refundOffering(offeringId);
        require(payment.balanceOf(BUYER_A) == 1_000_000, "failed offering refund");
    }

    function testGovernanceProposalVoteQueueAndExecute() public {
        (
            ArtFiVault vault,
            FractionalToken votes,
            ArtFiGovernanceBootstrap bootstrap,
            AcceptingBuyoutVerifier verifier
        ) = _deployGovernance(100 ether);
        require(address(vault.fractionalToken()) == address(votes), "vault token mismatch");
        require(address(verifier) != address(0), "verifier missing");
        votes.delegate(address(this));
        VM.roll(block.number + 1);

        TimelockController timelock = bootstrap.timelock();
        ArtFiGovernor governor = bootstrap.governor();
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        require(governor.proposalThreshold() == 10 ether, "proposal threshold not 10 percent");
        require(governor.rwaEligible(), "RWA eligibility failed");
        require(
            timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)),
            "timelock self admin"
        );
        require(
            !timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(bootstrap)),
            "bootstrap retained admin"
        );
        require(
            timelock.hasRole(timelock.PROPOSER_ROLE(), address(governor)), "governor proposer role"
        );
        require(
            timelock.hasRole(timelock.CANCELLER_ROLE(), address(governor)),
            "governor canceller role"
        );

        address[] memory targets = new address[](1);
        targets[0] = address(actions);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        bytes32 marketHash = keccak256("approved-market");
        calls[0] = abi.encodeCall(
            actions.recordMarketMigration, (marketHash, keccak256("evidence"), "ipfs://evidence")
        );
        string memory description = "Move trading visibility to an approved market";

        uint256 proposalId = governor.proposeWithKind(
            targets, values, calls, description, ArtFiGovernor.ProposalKind.MarketMigration
        );
        VM.roll(block.number + 2);
        governor.castVote(proposalId, 1);
        VM.roll(block.number + 6);
        governor.queue(targets, values, calls, keccak256(bytes(description)));
        VM.warp(block.timestamp + 3);
        governor.execute(targets, values, calls, keccak256(bytes(description)));
        require(actions.destinationMarketHash() == marketHash, "governance execution failed");
    }

    function testProposalRequiresTenPercentSnapshotOwnership() public {
        (, FractionalToken votes, ArtFiGovernanceBootstrap bootstrap,) =
            _deployGovernance(100 ether);
        ArtFiGovernor governor = bootstrap.governor();
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        require(votes.transfer(BUYER_A, 9 ether), "transfer A failed");
        require(votes.transfer(BUYER_B, 10 ether), "transfer B failed");
        VM.prank(BUYER_A);
        votes.delegate(BUYER_A);
        VM.prank(BUYER_B);
        votes.delegate(BUYER_B);
        VM.roll(block.number + 1);

        (address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _marketMigrationCall(actions, keccak256("threshold"));
        VM.prank(BUYER_A);
        (bool belowThreshold,) = address(governor)
            .call(
                abi.encodeCall(
                    governor.proposeWithKind,
                    (
                        targets,
                        values,
                        calls,
                        "Nine percent cannot propose",
                        ArtFiGovernor.ProposalKind.MarketMigration
                    )
                )
            );
        require(!belowThreshold, "sub-threshold holder proposed");

        VM.prank(BUYER_B);
        uint256 proposalId = governor.proposeWithKind(
            targets,
            values,
            calls,
            "Ten percent can propose",
            ArtFiGovernor.ProposalKind.MarketMigration
        );
        require(proposalId != 0, "threshold holder proposal missing");
    }

    function testApprovalIsStrictlyGreaterThanClassThreshold() public {
        (, FractionalToken votes, ArtFiGovernanceBootstrap bootstrap,) =
            _deployGovernance(100 ether);
        ArtFiGovernor governor = bootstrap.governor();
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        require(votes.transfer(BUYER_A, 50 ether), "transfer A failed");
        require(votes.transfer(BUYER_B, 50 ether), "transfer B failed");
        VM.prank(BUYER_A);
        votes.delegate(BUYER_A);
        VM.prank(BUYER_B);
        votes.delegate(BUYER_B);
        VM.roll(block.number + 1);

        (address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _marketMigrationCall(actions, keccak256("exact-half"));
        VM.prank(BUYER_A);
        uint256 proposalId = governor.proposeWithKind(
            targets,
            values,
            calls,
            "Exactly half must fail",
            ArtFiGovernor.ProposalKind.MarketMigration
        );
        VM.roll(block.number + 2);
        VM.prank(BUYER_A);
        governor.castVote(proposalId, 1);
        VM.roll(block.number + 6);
        require(
            governor.state(proposalId) == IGovernor.ProposalState.Defeated,
            "exactly 50 percent passed"
        );
    }

    function testProposalKindCannotBypassRequiredAction() public {
        (, FractionalToken votes, ArtFiGovernanceBootstrap bootstrap,) =
            _deployGovernance(100 ether);
        ArtFiGovernor governor = bootstrap.governor();
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        votes.delegate(address(this));
        VM.roll(block.number + 1);

        (address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _marketMigrationCall(actions, keccak256("mislabeled"));
        (bool ok,) = address(governor)
            .call(
                abi.encodeCall(
                    governor.proposeWithKind,
                    (
                        targets,
                        values,
                        calls,
                        "Cannot label market migration as buyout",
                        ArtFiGovernor.ProposalKind.ForcedBuyout
                    )
                )
            );
        require(!ok, "proposal classification bypassed");
    }

    function testSnapshotPreventsTransferredVotingPowerFromBeingCountedTwice() public {
        (, FractionalToken votes, ArtFiGovernanceBootstrap bootstrap,) =
            _deployGovernance(100 ether);
        ArtFiGovernor governor = bootstrap.governor();
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        require(votes.transfer(BUYER_A, 60 ether), "transfer A failed");
        VM.prank(BUYER_A);
        votes.delegate(BUYER_A);
        VM.roll(block.number + 1);

        (address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _marketMigrationCall(actions, keccak256("snapshot-transfer"));
        VM.prank(BUYER_A);
        uint256 proposalId = governor.proposeWithKind(
            targets,
            values,
            calls,
            "Transferred voting power must not count twice",
            ArtFiGovernor.ProposalKind.MarketMigration
        );
        VM.roll(block.number + 2);
        VM.prank(BUYER_A);
        require(votes.transfer(BUYER_B, 60 ether), "post-snapshot transfer failed");
        VM.prank(BUYER_B);
        votes.delegate(BUYER_B);

        VM.prank(BUYER_A);
        governor.castVote(proposalId, 1);
        VM.prank(BUYER_B);
        governor.castVote(proposalId, 1);
        (, uint256 forVotes,) = governor.proposalVotes(proposalId);
        require(forVotes == 60 ether, "transferred votes counted twice");

        VM.prank(BUYER_A);
        (bool votedTwice,) =
            address(governor).call(abi.encodeCall(governor.castVote, (proposalId, uint8(1))));
        require(!votedTwice, "same address voted twice");
    }

    function testPhysicalActionIsStrictlyGreaterThan666667Ppm() public {
        (, FractionalToken votes, ArtFiGovernanceBootstrap bootstrap,) =
            _deployGovernance(1_000_000 ether);
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        bytes memory callData = abi.encodeCall(
            actions.requestPhysicalAction,
            (
                ArtFiDAOActions.PhysicalAction.WarehouseTransfer,
                keccak256("warehouse-evidence"),
                "ipfs://warehouse-evidence"
            )
        );
        _assertExactApprovalFails(
            votes,
            bootstrap.governor(),
            actions,
            callData,
            ArtFiGovernor.ProposalKind.PhysicalAction,
            666_667 ether
        );
    }

    function testForcedBuyoutIsStrictlyGreaterThan80Percent() public {
        (, FractionalToken votes, ArtFiGovernanceBootstrap bootstrap,) =
            _deployGovernance(1_000_000 ether);
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        ArtFiDAOActions.ForcedBuyoutTerms memory terms = ArtFiDAOActions.ForcedBuyoutTerms({
            unitPriceWei: 1 ether,
            t0: uint48(block.timestamp),
            observationStart: 0,
            pricingRule: ArtFiDAOActions.BuyoutPricingRule.LastTenActualTrades,
            tradeCount: 10,
            evidenceHash: keccak256("buyout-boundary-evidence"),
            evidenceURI: "ipfs://buyout-boundary-evidence"
        });
        _assertExactApprovalFails(
            votes,
            bootstrap.governor(),
            actions,
            abi.encodeCall(actions.initiateForcedBuyout, (terms)),
            ArtFiGovernor.ProposalKind.ForcedBuyout,
            800_000 ether
        );
    }

    function testBuyoutPriceEvidenceFailsClosed() public {
        (
            ,
            FractionalToken votes,
            ArtFiGovernanceBootstrap bootstrap,
            AcceptingBuyoutVerifier verifier
        ) = _deployGovernance(100 ether);
        ArtFiGovernor governor = bootstrap.governor();
        ArtFiDAOActions actions = bootstrap.actionRegistry();
        votes.delegate(address(this));
        VM.roll(block.number + 1);
        verifier.setAccept(false);

        ArtFiDAOActions.ForcedBuyoutTerms memory terms = ArtFiDAOActions.ForcedBuyoutTerms({
            unitPriceWei: 1 ether,
            t0: uint48(block.timestamp),
            observationStart: 0,
            pricingRule: ArtFiDAOActions.BuyoutPricingRule.LastTenActualTrades,
            tradeCount: 10,
            evidenceHash: keccak256("ten-trade-vwap"),
            evidenceURI: "ipfs://buyout-evidence"
        });
        address[] memory targets = new address[](1);
        targets[0] = address(actions);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(actions.initiateForcedBuyout, (terms));
        string memory description = "Evidence-gated forced buyout";
        uint256 proposalId = governor.proposeWithKind(
            targets, values, calls, description, ArtFiGovernor.ProposalKind.ForcedBuyout
        );
        VM.roll(block.number + 2);
        governor.castVote(proposalId, 1);
        VM.roll(block.number + 6);
        governor.queue(targets, values, calls, keccak256(bytes(description)));
        VM.warp(block.timestamp + 3);
        (bool executed,) = address(governor)
            .call(
                abi.encodeCall(
                    governor.execute, (targets, values, calls, keccak256(bytes(description)))
                )
            );
        require(!executed, "invalid buyout price evidence executed");
    }

    function _deployGovernance(uint256 supply)
        private
        returns (
            ArtFiVault vault,
            FractionalToken votes,
            ArtFiGovernanceBootstrap bootstrap,
            AcceptingBuyoutVerifier verifier
        )
    {
        GovernanceNFT nft = new GovernanceNFT();
        nft.mint(address(this), 1);
        vault = new ArtFiVault(
            "Governed RWA Vault", nft, 1, address(this), address(this), address(this)
        );
        nft.approve(address(vault), 1);
        vault.deposit();
        votes = FractionalToken(
            vault.fractionalize("Governance Fractions", "GOVF", supply, address(this))
        );
        verifier = new AcceptingBuyoutVerifier();
        bootstrap = new ArtFiGovernanceBootstrap(vault, verifier, 2, 1, 5, 4);
    }

    function _createAuction(
        bytes32 requestId,
        uint256 openingBid,
        uint256 reservePrice,
        uint256 minimumBidIncrement,
        uint48 endsAt,
        uint48 extensionWindow,
        uint48 extensionDuration
    ) private returns (uint256 listingId) {
        listingId = market.createAuctionListing(
            requestId,
            asset,
            payment,
            100,
            openingBid,
            uint48(block.timestamp),
            endsAt,
            reservePrice,
            minimumBidIncrement,
            extensionWindow,
            extensionDuration
        );
    }

    function _revertSelector(bytes memory revertData) private pure returns (bytes4 selector) {
        if (revertData.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            selector := mload(add(revertData, 0x20))
        }
    }

    function _tryAuctionTerms(
        bytes32 requestId,
        uint48 endsAt,
        uint256 reservePrice,
        uint256 minimumBidIncrement,
        uint48 extensionWindow,
        uint48 extensionDuration
    ) private returns (bool ok) {
        (ok,) = address(market)
            .call(
                abi.encodeCall(
                    market.createAuctionListing,
                    (
                        requestId,
                        asset,
                        payment,
                        100,
                        100,
                        uint48(block.timestamp),
                        endsAt,
                        reservePrice,
                        minimumBidIncrement,
                        extensionWindow,
                        extensionDuration
                    )
                )
            );
    }

    function _marketMigrationCall(ArtFiDAOActions actions, bytes32 marketHash)
        private
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calls)
    {
        targets = new address[](1);
        targets[0] = address(actions);
        values = new uint256[](1);
        calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            actions.recordMarketMigration, (marketHash, keccak256("evidence"), "ipfs://evidence")
        );
    }

    function _assertExactApprovalFails(
        FractionalToken votes,
        ArtFiGovernor governor,
        ArtFiDAOActions actions,
        bytes memory callData,
        ArtFiGovernor.ProposalKind kind,
        uint256 exactVotes
    ) private {
        require(votes.transfer(BUYER_A, exactVotes), "boundary transfer failed");
        VM.prank(BUYER_A);
        votes.delegate(BUYER_A);
        VM.roll(block.number + 1);

        address[] memory targets = new address[](1);
        targets[0] = address(actions);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        calls[0] = callData;
        VM.prank(BUYER_A);
        uint256 proposalId = governor.proposeWithKind(
            targets, values, calls, "Exact class threshold must fail", kind
        );
        VM.roll(block.number + 2);
        VM.prank(BUYER_A);
        governor.castVote(proposalId, 1);
        VM.roll(block.number + 6);
        require(
            governor.state(proposalId) == IGovernor.ProposalState.Defeated,
            "exact class threshold passed"
        );
    }

    /// Pausing must not trap a seller's escrowed asset. `createListing` moves the
    /// seller's tokens into this contract; `cancelListing` is the only way a
    /// fixed-price seller with no bidder gets them back. If the pause blocks that
    /// exit, an administrative action has frozen a user's assets, which
    /// `PRD.md` §4.2 forbids outright. Every other exit — settleAuction,
    /// finalizeOffering, claimOffering, refundOffering, withdrawCredit — is
    /// already unpausable by design; this closes the one that was not.
    /// PR #46's property, now carried on the only path that still escrows. `PRD.md` §4.2.2 keeps
    /// escrow for auctions and removed it from the fixed-price path, so an auction with no bidder
    /// is where `cancelListing` is the seller's sole exit and must survive a pause.
    function testPauseDoesNotTrapEscrowedListing() public {
        uint256 before = asset.balanceOf(address(this));
        uint256 listingId = market.createAuctionListing(
            keccak256("paused-exit"),
            asset,
            payment,
            100,
            3,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            3,
            1,
            2,
            5
        );
        require(asset.balanceOf(address(this)) == before - 100, "escrow not taken");

        market.pause();

        // The seller retrieves their own escrow while the market is paused.
        market.cancelListing(listingId);
        require(asset.balanceOf(address(this)) == before, "seller escrow not returned");
    }

    /// The pause must still stop new market activity. Without this, removing
    /// `whenNotPaused` from the exit could be mistaken for weakening the pause.
    function testPauseStillBlocksNewListings() public {
        market.pause();
        try market.createListing(
            keccak256("paused-entry"),
            asset,
            payment,
            100,
            3,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            ArtFiMarket.ListingKind.FixedPrice
        ) {
            require(false, "paused market accepted a new listing");
        } catch {}
    }
}
