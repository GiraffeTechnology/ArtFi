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
}
