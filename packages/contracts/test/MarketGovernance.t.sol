// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ArtFiGovernor} from "../src/ArtFiGovernor.sol";
import {ArtFiGovernanceBootstrap} from "../src/ArtFiGovernanceBootstrap.sol";
import {ArtFiMarket} from "../src/ArtFiMarket.sol";
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

contract GovernedBox {
    uint256 public value;

    function setValue(uint256 nextValue) external {
        value = nextValue;
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

    function testFixedOrderPartialFillAndSellerClaim() public {
        uint256 listingId = market.createListing(
            keccak256("fixed"),
            asset,
            payment,
            100,
            3,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            ArtFiMarket.ListingKind.FixedPrice
        );
        VM.prank(BUYER_A);
        market.buyFixed(listingId, 40);
        require(asset.balanceOf(BUYER_A) == 40, "fixed asset amount");
        require(market.credits(address(this), address(payment)) == 120, "seller credit");
        market.withdrawCredit(payment);
        require(payment.balanceOf(address(this)) == 120, "seller withdrawal");
    }

    function testPilotCapFailsClosed() public {
        market.setPilotCap(BUYER_A, address(payment), 10);
        uint256 listingId = market.createListing(
            keccak256("pilot-cap"),
            asset,
            payment,
            100,
            3,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            ArtFiMarket.ListingKind.FixedPrice
        );
        VM.prank(BUYER_A);
        (bool ok,) = address(market).call(abi.encodeCall(market.buyFixed, (listingId, 4)));
        require(!ok, "pilot cap bypassed");
    }

    function testAuctionRefundExpiryAndSettlement() public {
        uint256 listingId = market.createListing(
            keccak256("auction"),
            asset,
            payment,
            100,
            100,
            uint48(block.timestamp),
            uint48(block.timestamp + 10),
            ArtFiMarket.ListingKind.Auction
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

    function testListingRequestReplayAndConflict() public {
        bytes32 requestId = keccak256("replay");
        uint48 start = uint48(block.timestamp);
        uint48 end = uint48(block.timestamp + 10);
        uint256 first = market.createListing(
            requestId, asset, payment, 20, 2, start, end, ArtFiMarket.ListingKind.FixedPrice
        );
        uint256 replay = market.createListing(
            requestId, asset, payment, 20, 2, start, end, ArtFiMarket.ListingKind.FixedPrice
        );
        require(first == replay, "listing replay changed id");
        (bool ok,) = address(market)
            .call(
                abi.encodeCall(
                    market.createListing,
                    (
                        requestId,
                        asset,
                        payment,
                        21,
                        2,
                        start,
                        end,
                        ArtFiMarket.ListingKind.FixedPrice
                    )
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
        FractionalToken votes = new FractionalToken(
            "Governance Fractions", "GOVF", address(this), 100 ether, address(this), address(this)
        );
        votes.delegate(address(this));
        VM.roll(block.number + 1);

        ArtFiGovernanceBootstrap bootstrap =
            new ArtFiGovernanceBootstrap(votes, 2, 1, 5, 1 ether, 4);
        TimelockController timelock = bootstrap.timelock();
        ArtFiGovernor governor = bootstrap.governor();
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

        GovernedBox box = new GovernedBox();
        address[] memory targets = new address[](1);
        targets[0] = address(box);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(box.setValue, (42));
        string memory description = "Set governed value";

        uint256 proposalId = governor.propose(targets, values, calls, description);
        VM.roll(block.number + 2);
        governor.castVote(proposalId, 1);
        VM.roll(block.number + 6);
        governor.queue(targets, values, calls, keccak256(bytes(description)));
        VM.warp(block.timestamp + 3);
        governor.execute(targets, values, calls, keccak256(bytes(description)));
        require(box.value() == 42, "governance execution failed");
    }
}
