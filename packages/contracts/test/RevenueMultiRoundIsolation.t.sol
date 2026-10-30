// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FractionalToken} from "../src/FractionalToken.sol";
import {IHistoricalFractionToken, RevenueDistributor} from "../src/RevenueDistributor.sol";

interface MultiRoundVm {
    function prank(address sender) external;
    function roll(uint256 blockNumber) external;
}

/// @dev TEST_ONLY payout behavior; no production token or funding authority.
contract MultiRoundPaymentToken is ERC20 {
    address public feeSender;

    constructor() ERC20("Test multi-round revenue", "TMR") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function enableOutboundFee(address sender) external {
        feeSender = sender;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from == feeSender && to != address(0) && value > 1) {
            super._update(from, address(0xDEAD), 1);
            super._update(from, to, value - 1);
        } else {
            super._update(from, to, value);
        }
    }
}

contract RevenueMultiRoundIsolationTest {
    MultiRoundVm private constant VM =
        MultiRoundVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant HOLDER_A = address(0xA11CE);
    address private constant HOLDER_B = address(0xB0B);
    FractionalToken private fractions;
    RevenueDistributor private distributor;
    MultiRoundPaymentToken private tokenA;
    MultiRoundPaymentToken private tokenB;
    uint48 private snapshot;

    function setUp() public {
        fractions =
            new FractionalToken("Multi-round snapshot", "MRS", address(this), 1000, address(this));
        distributor = new RevenueDistributor(
            IHistoricalFractionToken(address(fractions)), address(this), address(this)
        );
        tokenA = new MultiRoundPaymentToken();
        tokenB = new MultiRoundPaymentToken();
        tokenA.mint(address(this), 1e30);
        tokenB.mint(address(this), 1e30);
        tokenA.approve(address(distributor), type(uint256).max);
        tokenB.approve(address(distributor), type(uint256).max);
        require(fractions.transfer(HOLDER_A, 333), "holder A funding");
        require(fractions.transfer(HOLDER_B, 333), "holder B funding");
        snapshot = uint48(block.number);
        VM.roll(block.number + 1);
    }

    function testDifferentPayoutTokensKeepIndependentCustodyAndClaims() public {
        uint256 a = _fund(keccak256("token-a"), tokenA, 1001, snapshot);
        uint256 b = _fund(keccak256("token-b"), tokenB, 2003, snapshot);
        require(distributor.distributionCount() == 2, "round count");
        require(tokenA.balanceOf(address(distributor)) == 1001, "A funding");
        require(tokenB.balanceOf(address(distributor)) == 2003, "B funding");
        _claim(HOLDER_A, a);
        require(distributor.claimed(a, HOLDER_A), "A claim missing");
        require(!distributor.claimed(b, HOLDER_A), "A claim consumed B");
        require(distributor.totalClaimed(b) == 0, "A claim changed B accounting");
        require(tokenB.balanceOf(address(distributor)) == 2003, "A claim spent B");
        _claim(HOLDER_A, b);
        require(tokenA.balanceOf(HOLDER_A) == Math.mulDiv(1001, 333, 1000), "A payout");
        require(tokenB.balanceOf(HOLDER_A) == Math.mulDiv(2003, 333, 1000), "B payout");
        _claim(HOLDER_B, a);
        distributor.claim(a);
        _assertRoundConservation(a, tokenA, 1001);
        require(
            distributor.remainingRevenue(b) == 2003 - Math.mulDiv(2003, 333, 1000),
            "B remainder changed"
        );
    }

    function testSamePayoutTokenAggregatesCustodyWithoutMixingSnapshotRights() public {
        uint256 first = _fund(keccak256("old-snapshot"), tokenA, 1000, snapshot);
        require(fractions.transfer(HOLDER_A, 100), "later transfer");
        uint48 later = uint48(block.number);
        VM.roll(block.number + 1);
        uint256 second = _fund(keccak256("new-snapshot"), tokenA, 1000, later);
        _claim(HOLDER_A, second);
        require(tokenA.balanceOf(HOLDER_A) == 433, "new snapshot entitlement");
        _claim(HOLDER_A, first);
        require(tokenA.balanceOf(HOLDER_A) == 766, "old snapshot changed");
        _claim(HOLDER_B, first);
        _claim(HOLDER_B, second);
        distributor.claim(second);
        distributor.claim(first);
        require(distributor.totalClaimed(first) == 1000, "first accounting");
        require(distributor.totalClaimed(second) == 1000, "second accounting");
        require(tokenA.balanceOf(address(distributor)) == 0, "cross-round residual");
    }

    function testOutboundFeeRollbackDoesNotConsumeAnotherRound() public {
        uint256 a = _fund(keccak256("fee-round"), tokenA, 1000, snapshot);
        uint256 b = _fund(keccak256("healthy-round"), tokenB, 2000, snapshot);
        tokenA.enableOutboundFee(address(distributor));
        VM.prank(HOLDER_A);
        (bool ok, bytes memory reason) =
            address(distributor).call(abi.encodeCall(distributor.claim, (a)));
        require(
            !ok && bytes4(reason) == RevenueDistributor.TransferAmountMismatch.selector,
            "expected exact transfer rejection"
        );
        require(
            !distributor.claimed(a, HOLDER_A) && distributor.totalClaimed(a) == 0,
            "failed A claim consumed"
        );
        require(
            tokenA.balanceOf(address(distributor)) == 1000 && tokenA.balanceOf(HOLDER_A) == 0,
            "failed A transfer not rolled back"
        );
        _claim(HOLDER_A, b);
        require(distributor.claimed(b, HOLDER_A), "healthy B claim blocked");
        require(tokenB.balanceOf(HOLDER_A) == 666, "healthy B payout");
        require(distributor.remainingRevenue(a) == 1000, "A reservation changed");
    }

    function testRequestIdCannotBeReboundToAnotherPayoutToken() public {
        bytes32 requestId = keccak256("same-request");
        uint256 a = _fund(requestId, tokenA, 1000, snapshot);
        uint256 beforeA = tokenA.balanceOf(address(this));
        uint256 beforeB = tokenB.balanceOf(address(this));
        require(_fund(requestId, tokenA, 1000, snapshot) == a, "replay changed ID");
        require(tokenA.balanceOf(address(this)) == beforeA, "replay funded twice");
        (bool ok, bytes memory reason) = address(distributor)
            .call(
                abi.encodeCall(distributor.createDistribution, (requestId, tokenB, 1000, snapshot))
            );
        require(
            !ok && bytes4(reason) == RevenueDistributor.IdempotencyConflict.selector,
            "cross-token request accepted"
        );
        require(distributor.distributionCount() == 1, "conflict created round");
        require(
            tokenB.balanceOf(address(this)) == beforeB
                && tokenB.balanceOf(address(distributor)) == 0,
            "conflict moved B"
        );
        require(
            distributor.totalClaimed(a) == 0 && distributor.remainingRevenue(a) == 1000,
            "conflict mutated A"
        );
    }

    function testFuzzInterleavedDifferentTokenClaimsConserveBothRounds(
        uint96 rawA,
        uint96 rawB,
        bool reverse
    ) public {
        uint256 amountA = uint256(rawA) % 1e24 + 1000;
        uint256 amountB = uint256(rawB) % 1e24 + 1000;
        uint256 a = _fund(keccak256("fuzz-a"), tokenA, amountA, snapshot);
        uint256 b = _fund(keccak256("fuzz-b"), tokenB, amountB, snapshot);
        _claim(HOLDER_A, reverse ? b : a);
        _claim(HOLDER_B, reverse ? a : b);
        _claim(HOLDER_A, reverse ? a : b);
        _claim(HOLDER_B, reverse ? b : a);
        distributor.claim(a);
        distributor.claim(b);
        _assertRoundConservation(a, tokenA, amountA);
        _assertRoundConservation(b, tokenB, amountB);
        require(
            tokenA.balanceOf(HOLDER_A) == Math.mulDiv(amountA, 333, 1000), "A fraction entitlement"
        );
        require(
            tokenB.balanceOf(HOLDER_A) == Math.mulDiv(amountB, 333, 1000), "B fraction entitlement"
        );
    }

    function testFuzzSameTokenMultipleRoundsAccountForEachDust(uint96 rawA, uint96 rawB) public {
        uint256 amountA = uint256(rawA) % 1e24 + 1000;
        uint256 amountB = uint256(rawB) % 1e24 + 1000;
        uint256 a = _fund(keccak256("shared-a"), tokenA, amountA, snapshot);
        uint256 b = _fund(keccak256("shared-b"), tokenA, amountB, snapshot);
        _claim(HOLDER_A, b);
        _claim(HOLDER_B, a);
        distributor.claim(a);
        _claim(HOLDER_A, a);
        distributor.claim(b);
        _claim(HOLDER_B, b);
        uint256 remainderA = distributor.remainingRevenue(a);
        uint256 remainderB = distributor.remainingRevenue(b);
        require(remainderA < 3 && remainderB < 3, "per-round dust bound");
        require(distributor.totalClaimed(a) + remainderA == amountA, "A conservation");
        require(distributor.totalClaimed(b) + remainderB == amountB, "B conservation");
        require(
            tokenA.balanceOf(address(distributor)) == remainderA + remainderB,
            "shared-token custody conservation"
        );
        require(
            distributor.claimable(a, HOLDER_A) == 0 && distributor.claimable(b, HOLDER_A) == 0,
            "consumed rights still claimable"
        );
    }

    function _fund(
        bytes32 requestId,
        MultiRoundPaymentToken token,
        uint256 amount,
        uint48 timepoint
    ) private returns (uint256) {
        return distributor.createDistribution(requestId, token, amount, timepoint);
    }

    function _claim(address holder, uint256 distributionId) private {
        VM.prank(holder);
        distributor.claim(distributionId);
    }

    function _assertRoundConservation(
        uint256 distributionId,
        MultiRoundPaymentToken token,
        uint256 funded
    ) private view {
        uint256 remainder = distributor.remainingRevenue(distributionId);
        require(
            distributor.totalClaimed(distributionId) + remainder == funded, "round conservation"
        );
        require(remainder < 3, "round dust bound");
        require(token.balanceOf(address(distributor)) == remainder, "round custody conservation");
    }
}
