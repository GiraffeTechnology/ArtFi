// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArtFiMarket} from "../src/ArtFiMarket.sol";

interface TransferAccountingVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

/// @dev TEST_ONLY tokens and signatures; no external asset or account is used.
contract AccountingMarketToken is ERC20 {
    address private watchedFrom;
    address private watchedTo;
    uint8 private mode;

    constructor() ERC20("Accounting fixture", "ACCT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function watch(address from, address to, uint8 nextMode) external {
        watchedFrom = from;
        watchedTo = to;
        mode = nextMode;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != watchedFrom || to != watchedTo || mode == 0 || from == address(0)) {
            super._update(from, to, amount);
            return;
        }
        if (mode == 1) super._update(from, address(0), 1);
        if (mode == 2) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
            return;
        }
        super._update(from, to, amount);
        if (mode == 3) super._update(address(0), to, 1);
        if (mode == 4) super._update(to, address(0), amount + 1);
        if (mode == 5) super._update(address(0), from, 1);
    }
}

contract AccountingMarketSeller {
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }

    function approve(IERC20 token, address spender) external {
        require(token.approve(spender, type(uint256).max));
    }
}

contract MarketTransferAccountingTest {
    TransferAccountingVm private constant VM =
        TransferAccountingVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BIDDER = address(0xB0B);
    address private constant OTHER_BIDDER = address(0xCA401);
    ArtFiMarket private market;
    AccountingMarketToken private asset;
    AccountingMarketToken private payment;
    AccountingMarketSeller private seller;

    function setUp() public {
        VM.warp(1000);
        market = new ArtFiMarket(address(this), address(this), address(this));
        asset = new AccountingMarketToken();
        payment = new AccountingMarketToken();
        seller = new AccountingMarketSeller();
        market.setTokenPermission(address(asset), true, false);
        market.setTokenPermission(address(payment), false, true);
        for (uint256 i; i < 4; ++i) {
            address actor =
                i == 0 ? address(this) : i == 1 ? address(seller) : i == 2 ? BIDDER : OTHER_BIDDER;
            asset.mint(actor, 1e24);
            payment.mint(actor, 1e24);
            market.setPilotCap(actor, address(payment), 1e24);
        }
        asset.approve(address(market), type(uint256).max);
        payment.approve(address(market), type(uint256).max);
        seller.approve(asset, address(market));
        VM.prank(BIDDER);
        payment.approve(address(market), type(uint256).max);
        VM.prank(OTHER_BIDDER);
        payment.approve(address(market), type(uint256).max);
    }

    function testPaymentSenderFeeRejectsAtomicFill() public {
        _rejectFill(false, 1, 10);
    }

    function testFractionSenderFeeRollsBackPaymentLeg() public {
        _rejectFill(true, 1, 10);
    }

    function testSenderRebateRejectsAtomicFill() public {
        _rejectFill(false, 5, 10);
    }

    function testRecipientDecreaseUsesAmountMismatch() public {
        _rejectFill(false, 4, 10);
    }

    function testFuzzNonExactEitherFillLegRollsBack(
        uint96 rawAmount,
        uint8 rawMode,
        bool fractionLeg
    ) public {
        _rejectFill(fractionLeg, rawMode % 5 + 1, uint256(rawAmount) % 99 + 2);
    }

    function testExactPartialFillsPreserveSignedLimitAndZeroCustody() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        market.fillIntent(intent, hex"01", 40);
        market.fillIntent(intent, hex"01", 60);
        require(market.intentFilled(market.intentHash(intent)) == 100, "filled quantity");
        require(market.pilotPaymentUsed(address(this), address(payment)) == 200, "payment cap");
        require(payment.balanceOf(address(this)) == 1e24 - 200, "buyer debit");
        require(payment.balanceOf(address(seller)) == 1e24 + 200, "seller credit");
        require(asset.balanceOf(address(seller)) == 1e24 - 100, "seller asset debit");
        require(asset.balanceOf(address(this)) == 1e24 + 100, "buyer asset credit");
        require(
            payment.balanceOf(address(market)) == 0 && asset.balanceOf(address(market)) == 0,
            "resting custody"
        );
    }

    function testAuctionEscrowSenderFeeDoesNotConsumeRequest() public {
        asset.watch(address(this), address(market), 1);
        (bool ok, bytes memory reason) = address(this).call(abi.encodeCall(this.createAuction, ()));
        _amountMismatch(ok, reason);
        require(
            asset.balanceOf(address(this)) == 1e24 && asset.balanceOf(address(market)) == 0,
            "escrow rollback"
        );
        asset.watch(address(0), address(0), 0);
        require(createAuction() == 1, "failed request consumed ID");
        require(
            createAuction() == 1 && asset.balanceOf(address(market)) == 100, "request replay escrow"
        );
    }

    function testBidSenderFeeDoesNotSpendCapOrReplaceLeader() public {
        uint256 id = createAuction();
        payment.watch(BIDDER, address(market), 1);
        VM.prank(BIDDER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.placeBid, (id, 100)));
        _amountMismatch(ok, reason);
        require(market.pilotPaymentUsed(BIDDER, address(payment)) == 0, "bid cap consumed");
        require(
            payment.balanceOf(BIDDER) == 1e24 && payment.balanceOf(address(market)) == 0,
            "bid debit escaped"
        );
        (,,,,,,,,, address highestBidder, uint256 highestBid) = market.listings(id);
        require(highestBidder == address(0) && highestBid == 0, "failed bidder became leader");
    }

    function testCreditSenderFeePreservesOtherBidAndCredit() public {
        _rejectCredit(1);
    }

    function testCreditRecipientFeePreservesWithdrawableCredit() public {
        _rejectCredit(2);
    }

    function testCancelFeeKeepsAuctionAssetAndState() public {
        uint256 id = createAuction();
        asset.watch(address(market), address(this), 2);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.cancelListing, (id)));
        _amountMismatch(ok, reason);
        (,,, uint256 remaining,,,,, ArtFiMarket.State state,,) = market.listings(id);
        require(state == ArtFiMarket.State.Active && remaining == 100, "cancel state consumed");
        require(
            asset.balanceOf(address(market)) == 100 && asset.balanceOf(address(this)) == 1e24 - 100,
            "cancel custody"
        );
    }

    function testUnsuccessfulOfferingRefundFeePreservesContribution() public {
        uint256 id =
            market.createOffering(keccak256("refund"), asset, payment, 100, 200, 500, 1000, 1100);
        VM.prank(BIDDER);
        market.contribute(id, 100);
        VM.warp(1100);
        market.finalizeOffering(id);
        payment.watch(address(market), BIDDER, 2);
        VM.prank(BIDDER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.refundOffering, (id)));
        _amountMismatch(ok, reason);
        require(market.contributions(id, BIDDER) == 100, "refund entitlement consumed");
        require(
            payment.balanceOf(address(market)) == 100 && payment.balanceOf(BIDDER) == 1e24 - 100,
            "refund custody"
        );
    }

    function testSuccessfulOfferingClaimFeePreservesAllocation() public {
        uint256 id =
            market.createOffering(keccak256("claim"), asset, payment, 100, 100, 200, 1000, 1100);
        VM.prank(BIDDER);
        market.contribute(id, 200);
        VM.warp(1100);
        market.finalizeOffering(id);
        asset.watch(address(market), BIDDER, 2);
        VM.prank(BIDDER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.claimOffering, (id)));
        _amountMismatch(ok, reason);
        require(market.allocations(id, BIDDER) == 100, "allocation consumed");
        require(
            asset.balanceOf(address(market)) == 100 && asset.balanceOf(BIDDER) == 1e24,
            "allocation custody"
        );
    }

    function createAuction() public returns (uint256) {
        return market.createAuctionListing(
            keccak256("auction"), asset, payment, 100, 100, 1000, 1100, 100, 1, 10, 10
        );
    }

    function _rejectCredit(uint8 mode) private {
        uint256 id = createAuction();
        VM.prank(BIDDER);
        market.placeBid(id, 100);
        VM.prank(OTHER_BIDDER);
        market.placeBid(id, 120);
        payment.watch(address(market), BIDDER, mode);
        VM.prank(BIDDER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.withdrawCredit, (payment)));
        _amountMismatch(ok, reason);
        require(market.credits(BIDDER, address(payment)) == 100, "credit consumed");
        require(payment.balanceOf(BIDDER) == 1e24 - 100, "recipient changed");
        require(payment.balanceOf(address(market)) == 220, "other bidder custody consumed");
        payment.watch(address(0), address(0), 0);
        VM.prank(BIDDER);
        market.withdrawCredit(payment);
        require(
            market.credits(BIDDER, address(payment)) == 0 && payment.balanceOf(BIDDER) == 1e24,
            "exact retry"
        );
        require(payment.balanceOf(address(market)) == 120, "leader custody after retry");
    }

    function _rejectFill(bool fractionLeg, uint8 mode, uint256 amount) private {
        ArtFiMarket.SaleIntent memory intent = _intent();
        if (fractionLeg) asset.watch(address(seller), address(this), mode);
        else payment.watch(address(this), address(seller), mode);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.fillIntent, (intent, hex"01", amount)));
        _amountMismatch(ok, reason);
        require(market.intentFilled(market.intentHash(intent)) == 0, "failed fill consumed intent");
        require(
            market.pilotPaymentUsed(address(this), address(payment)) == 0,
            "failed fill consumed cap"
        );
        require(
            asset.balanceOf(address(this)) == 1e24 && asset.balanceOf(address(seller)) == 1e24,
            "asset rollback"
        );
        require(
            payment.balanceOf(address(this)) == 1e24 && payment.balanceOf(address(seller)) == 1e24,
            "payment rollback"
        );
        require(
            asset.balanceOf(address(market)) == 0 && payment.balanceOf(address(market)) == 0,
            "unexpected custody"
        );
    }

    function _intent() private view returns (ArtFiMarket.SaleIntent memory) {
        return ArtFiMarket.SaleIntent(
            address(seller),
            address(asset),
            address(payment),
            100,
            2,
            address(this),
            1,
            1000,
            2000,
            0
        );
    }

    function _amountMismatch(bool ok, bytes memory reason) private pure {
        require(!ok, "non-exact transfer accepted");
        require(
            reason.length >= 4 && bytes4(reason) == ArtFiMarket.TransferAmountMismatch.selector,
            "wrong rejection"
        );
    }
}
