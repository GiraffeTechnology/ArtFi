// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArtFiMarket} from "../src/ArtFiMarket.sol";

interface AuctionIsolationVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

/// @dev Test-only token that can refuse one transfer edge without changing another token.
contract AuctionIsolationToken is ERC20 {
    address private blockedFrom;
    address private blockedTo;

    constructor(string memory symbol_) ERC20(symbol_, symbol_) {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function blockEdge(address from, address to) external {
        blockedFrom = from;
        blockedTo = to;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(from != blockedFrom || to != blockedTo, "blocked test transfer");
        super._update(from, to, amount);
    }
}

contract AuctionCreditIsolationTest {
    AuctionIsolationVm private constant VM =
        AuctionIsolationVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    uint256 private constant FUNDS = 1e24;
    ArtFiMarket private market;
    AuctionIsolationToken private asset;
    AuctionIsolationToken private usd;
    AuctionIsolationToken private eur;

    function setUp() public {
        VM.warp(1000);
        market = new ArtFiMarket(address(this), address(this), address(this));
        asset = new AuctionIsolationToken("FRACTION");
        usd = new AuctionIsolationToken("USD");
        eur = new AuctionIsolationToken("EUR");
        market.setTokenPermission(address(asset), true, false);
        market.setTokenPermission(address(usd), false, true);
        market.setTokenPermission(address(eur), false, true);
        asset.mint(address(this), 10000);
        asset.approve(address(market), type(uint256).max);
        _fund(usd, ALICE);
        _fund(usd, BOB);
        _fund(eur, ALICE);
        _fund(eur, BOB);
    }

    function testInterleavedAuctionsShareRefundCreditsWithoutDoubleWithdrawal() public {
        uint256 first = _auction("one", usd, 100);
        uint256 second = _auction("two", usd, 200);
        _bid(ALICE, first, 100);
        _bid(ALICE, second, 200);
        _bid(BOB, first, 110);
        _bid(BOB, second, 220);
        require(market.credits(ALICE, address(usd)) == 300, "aggregate losing bids");
        _withdraw(ALICE, usd);
        require(usd.balanceOf(ALICE) == FUNDS, "losing bidder not restored");
        VM.prank(ALICE);
        (bool twice,) = address(market).call(abi.encodeCall(market.withdrawCredit, (IERC20(usd))));
        require(!twice, "refund withdrawn twice");
        require(usd.balanceOf(address(market)) == 330, "active winners consumed");
        VM.warp(2000);
        market.settleAuction(second);
        market.settleAuction(first);
        require(asset.balanceOf(BOB) == 200, "winner assets");
        require(market.credits(address(this), address(usd)) == 330, "seller aggregate");
        market.withdrawCredit(usd);
        require(usd.balanceOf(address(this)) == 330, "seller payment");
        require(usd.balanceOf(address(market)) == 0, "custody residue");
    }

    function testPaymentTokensKeepSeparateCreditsAndSettlement() public {
        uint256 first = _auction("usd", usd, 100);
        uint256 second = _auction("eur", eur, 200);
        _bid(ALICE, first, 100);
        _bid(BOB, first, 120);
        _bid(ALICE, second, 200);
        _bid(BOB, second, 230);
        _withdraw(ALICE, eur);
        require(market.credits(ALICE, address(usd)) == 100, "other token credit changed");
        require(usd.balanceOf(address(market)) == 220, "USD custody changed");
        require(eur.balanceOf(address(market)) == 230, "EUR winner custody");
        VM.warp(2000);
        market.settleAuction(first);
        market.settleAuction(second);
        market.withdrawCredit(eur);
        require(market.credits(address(this), address(usd)) == 120, "seller USD lost");
        _withdraw(ALICE, usd);
        market.withdrawCredit(usd);
        require(usd.balanceOf(address(market)) == 0, "USD residue");
        require(eur.balanceOf(address(market)) == 0, "EUR residue");
    }

    function testRejectedOutbidRollsBackCapWinnerAndRefundThenOtherAuctionContinues() public {
        uint256 first = _auction("blocked-bid", usd, 100);
        uint256 second = _auction("healthy-bid", eur, 200);
        _bid(ALICE, first, 100);
        usd.blockEdge(BOB, address(market));
        VM.prank(BOB);
        (bool accepted,) = address(market).call(abi.encodeCall(market.placeBid, (first, 110)));
        require(!accepted, "blocked incoming transfer accepted");
        require(market.pilotPaymentUsed(BOB, address(usd)) == 0, "failed bid consumed cap");
        require(market.credits(ALICE, address(usd)) == 0, "failed bid granted refund");
        _assertListing(first, ArtFiMarket.State.Active, ALICE, 100, 100);
        require(usd.balanceOf(address(market)) == 100, "failed bid custody changed");
        _bid(BOB, second, 210);
        VM.warp(2000);
        market.settleAuction(second);
        market.settleAuction(first);
        require(asset.balanceOf(ALICE) == 100 && asset.balanceOf(BOB) == 100, "winners changed");
        require(market.credits(address(this), address(usd)) == 100, "first proceeds");
        require(market.credits(address(this), address(eur)) == 210, "second proceeds");
    }

    function testRejectedRefundPreservesCreditAndOtherTokenCanWithdrawWhilePaused() public {
        uint256 first = _auction("usd-refund", usd, 100);
        uint256 second = _auction("eur-refund", eur, 200);
        _bid(ALICE, first, 100);
        _bid(BOB, first, 110);
        _bid(ALICE, second, 200);
        _bid(BOB, second, 220);
        usd.blockEdge(address(market), ALICE);
        market.pause();
        VM.prank(ALICE);
        (bool paid,) = address(market).call(abi.encodeCall(market.withdrawCredit, (IERC20(usd))));
        require(!paid, "blocked outgoing transfer paid");
        require(market.credits(ALICE, address(usd)) == 100, "failed withdrawal erased credit");
        require(usd.balanceOf(address(market)) == 210, "failed withdrawal changed custody");
        _withdraw(ALICE, eur);
        require(eur.balanceOf(ALICE) == FUNDS, "other token refund blocked");
        usd.blockEdge(address(0), address(0));
        _withdraw(ALICE, usd);
        require(usd.balanceOf(ALICE) == FUNDS, "recovered credit not paid");
        VM.warp(2000);
        market.settleAuction(first);
        market.settleAuction(second);
        require(asset.balanceOf(BOB) == 200, "paused exit failed");
    }

    function testRejectedAssetDeliveryLeavesAuctionRecoverableAndOtherSettlementIsolated() public {
        uint256 first = _auction("blocked-delivery", usd, 100);
        uint256 second = _auction("healthy-delivery", eur, 200);
        _bid(ALICE, first, 100);
        _bid(BOB, second, 200);
        asset.blockEdge(address(market), ALICE);
        VM.warp(2000);
        (bool settled,) = address(market).call(abi.encodeCall(market.settleAuction, (first)));
        require(!settled, "blocked delivery settled");
        _assertListing(first, ArtFiMarket.State.Active, ALICE, 100, 100);
        require(market.credits(address(this), address(usd)) == 0, "failed delivery paid seller");
        market.settleAuction(second);
        require(asset.balanceOf(BOB) == 100, "other settlement failed");
        require(asset.balanceOf(address(market)) == 100, "failed delivery escrow lost");
        asset.blockEdge(address(0), address(0));
        market.settleAuction(first);
        _assertListing(first, ArtFiMarket.State.Settled, ALICE, 100, 0);
        require(asset.balanceOf(ALICE) == 100, "recovered delivery failed");
        (bool twice,) = address(market).call(abi.encodeCall(market.settleAuction, (first)));
        require(!twice, "settled twice");
        require(market.credits(address(this), address(usd)) == 100, "seller duplicate proceeds");
    }

    function testFuzzSelfOutbidRefundAndWinnerConserve(uint96 rawFirst, uint96 rawIncrement)
        public
    {
        uint256 firstBid = 1 + uint256(rawFirst) % 1e18;
        uint256 nextBid = firstBid + 1 + uint256(rawIncrement) % 1e18;
        uint256 id = _auction("self-outbid", usd, 1);
        _bid(ALICE, id, firstBid);
        _bid(ALICE, id, nextBid);
        require(market.credits(ALICE, address(usd)) == firstBid, "self outbid refund");
        require(
            market.pilotPaymentUsed(ALICE, address(usd)) == firstBid + nextBid, "cap accounting"
        );
        _withdraw(ALICE, usd);
        require(usd.balanceOf(ALICE) == FUNDS - nextBid, "bidder conservation");
        VM.warp(2000);
        market.settleAuction(id);
        market.withdrawCredit(usd);
        require(usd.balanceOf(address(this)) == nextBid, "seller conservation");
        require(usd.balanceOf(address(market)) == 0, "payment residue");
        require(asset.balanceOf(ALICE) == 100, "self outbid winner");
    }

    function testFuzzTwoAuctionConservation(uint96 rawFirst, uint96 rawSecond, bool reverse)
        public
    {
        uint256 bidOne = 1 + uint256(rawFirst) % 1e18;
        uint256 bidTwo = 1 + uint256(rawSecond) % 1e18;
        uint256 first = _auction("fuzz-one", usd, 1);
        uint256 second = _auction("fuzz-two", usd, 1);
        _bid(ALICE, first, bidOne);
        _bid(ALICE, second, bidTwo);
        _bid(BOB, first, bidOne + 1);
        _bid(BOB, second, bidTwo + 1);
        VM.warp(2000);
        market.settleAuction(reverse ? second : first);
        _withdraw(ALICE, usd);
        market.settleAuction(reverse ? first : second);
        market.withdrawCredit(usd);
        require(usd.balanceOf(ALICE) == FUNDS, "loser conservation");
        require(usd.balanceOf(BOB) == FUNDS - bidOne - bidTwo - 2, "winner conservation");
        require(usd.balanceOf(address(this)) == bidOne + bidTwo + 2, "seller conservation");
        require(usd.balanceOf(address(market)) == 0, "joint custody residue");
        require(asset.balanceOf(BOB) == 200, "joint assets");
        require(
            asset.balanceOf(address(this)) + asset.balanceOf(BOB) == 10000, "asset conservation"
        );
    }

    function _fund(AuctionIsolationToken token, address account) private {
        token.mint(account, FUNDS);
        market.setPilotCap(account, address(token), FUNDS);
        VM.prank(account);
        token.approve(address(market), type(uint256).max);
    }

    function _auction(string memory key, IERC20 payment, uint256 opening)
        private
        returns (uint256)
    {
        return market.createAuctionListing(
            keccak256(bytes(key)), asset, payment, 100, opening, 1000, 2000, opening, 1, 10, 10
        );
    }

    function _bid(address account, uint256 id, uint256 amount) private {
        VM.prank(account);
        market.placeBid(id, amount);
    }

    function _withdraw(address account, IERC20 token) private {
        VM.prank(account);
        market.withdrawCredit(token);
    }

    function _assertListing(
        uint256 id,
        ArtFiMarket.State expected,
        address bidder,
        uint256 bid,
        uint256 remaining
    ) private view {
        (,,, uint256 amount,,,,, ArtFiMarket.State state, address highest, uint256 highestBid) =
            market.listings(id);
        require(
            state == expected && highest == bidder && highestBid == bid && amount == remaining,
            "listing state changed"
        );
    }
}
