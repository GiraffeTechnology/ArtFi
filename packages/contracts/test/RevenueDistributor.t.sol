// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {FractionalToken} from "../src/FractionalToken.sol";
import {IHistoricalFractionToken, RevenueDistributor} from "../src/RevenueDistributor.sol";

interface RevenueVm {
    function prank(address sender) external;
    function roll(uint256 blockNumber) external;
}

contract RevenuePaymentToken is ERC20 {
    constructor() ERC20("Test Revenue", "TREV") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract FeeRevenuePaymentToken is RevenuePaymentToken {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 1) {
            super._update(from, address(0xDEAD), 1);
            super._update(from, to, value - 1);
            return;
        }
        super._update(from, to, value);
    }
}

contract OutboundFeeRevenuePaymentToken is RevenuePaymentToken {
    address private immutable _feeSender;

    constructor(address feeSender_) {
        _feeSender = feeSender_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == _feeSender && to != address(0) && value > 1) {
            super._update(from, address(0xDEAD), 1);
            super._update(from, to, value - 1);
            return;
        }
        super._update(from, to, value);
    }
}

contract RevenueInvariantHandler {
    RevenueVm private constant VM =
        RevenueVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    RevenueDistributor private immutable _distributor;
    RevenuePaymentToken private immutable _revenue;
    uint48 private immutable _snapshot;
    address private immutable _holderA;
    address private immutable _holderB;

    uint256 public callCount;
    uint256 public funded;
    uint256 public claimedAmount;
    uint256 private _nonce;

    constructor(
        RevenueDistributor distributor_,
        RevenuePaymentToken revenue_,
        uint48 snapshot_,
        address holderA_,
        address holderB_
    ) {
        _distributor = distributor_;
        _revenue = revenue_;
        _snapshot = snapshot_;
        _holderA = holderA_;
        _holderB = holderB_;
        revenue_.approve(address(distributor_), type(uint256).max);
    }

    function fundAndClaim(uint96 rawRevenue) external {
        ++callCount;
        uint256 amount = uint256(rawRevenue) % 10_000 ether + 4;
        if (_revenue.balanceOf(address(this)) < amount) return;
        uint256 distributionId = _distributor.createDistribution(
            keccak256(abi.encode("invariant-revenue", _nonce++)), _revenue, amount, _snapshot
        );
        funded += amount;

        VM.prank(_holderA);
        try _distributor.claim(distributionId) {} catch {}
        VM.prank(_holderB);
        try _distributor.claim(distributionId) {} catch {}
        claimedAmount += _distributor.totalClaimed(distributionId);
    }
}

contract RevenueDistributorTest {
    using Math for uint256;

    RevenueVm private constant VM =
        RevenueVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant HOLDER_A = address(0xA11CE);
    address private constant HOLDER_B = address(0xB0B);
    address private constant OUTSIDER = address(0xCAFE);

    FractionalToken private fractions;
    RevenuePaymentToken private revenue;
    RevenueDistributor private distributor;
    RevenueInvariantHandler private invariantHandler;
    uint48 private snapshot;

    function setUp() public {
        fractions = new FractionalToken(
            "Snapshot Fractions", "SNAP", address(this), 1_000 ether, address(this), address(this)
        );
        revenue = new RevenuePaymentToken();
        distributor = new RevenueDistributor(
            IHistoricalFractionToken(address(fractions)), address(this), address(this)
        );
        revenue.mint(address(this), 1_000_000_000 ether);
        revenue.approve(address(distributor), type(uint256).max);

        require(fractions.transfer(HOLDER_A, 250 ether), "holder A transfer failed");
        require(fractions.transfer(HOLDER_B, 250 ether), "holder B transfer failed");
        snapshot = uint48(block.number);
        VM.roll(block.number + 1);
        invariantHandler =
            new RevenueInvariantHandler(distributor, revenue, snapshot, HOLDER_A, HOLDER_B);
        distributor.grantRole(distributor.DISTRIBUTOR_ROLE(), address(invariantHandler));
        revenue.mint(address(invariantHandler), 1_000_000 ether);
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(invariantHandler);
    }

    function testClaimsUseSnapshotBalancesAfterFractionsMove() public {
        uint256 distributionId = _createDistribution(keccak256("snapshot-move"), 1_000 ether);
        require(revenue.balanceOf(HOLDER_A) == 0, "revenue pushed during funding");
        require(revenue.balanceOf(HOLDER_B) == 0, "revenue pushed during funding");

        require(fractions.transfer(HOLDER_A, 500 ether), "post-snapshot transfer failed");
        VM.prank(HOLDER_A);
        distributor.claim(distributionId);
        VM.prank(HOLDER_B);
        distributor.claim(distributionId);
        distributor.claim(distributionId);

        require(revenue.balanceOf(HOLDER_A) == 250 ether, "holder A snapshot claim");
        require(revenue.balanceOf(HOLDER_B) == 250 ether, "holder B snapshot claim");
        require(revenue.balanceOf(address(this)) == 1_000_000_000 ether - 500 ether, "owner claim");
        require(distributor.totalClaimed(distributionId) == 1_000 ether, "claim total");
    }

    function testHistoricalBalancesAreIndependentFromCurrentOwnership() public {
        require(fractions.getPastBalance(HOLDER_A, snapshot) == 250 ether, "snapshot holder A");
        require(fractions.getPastBalance(HOLDER_B, snapshot) == 250 ether, "snapshot holder B");
        require(fractions.transfer(HOLDER_A, 500 ether), "post-snapshot transfer failed");
        require(fractions.balanceOf(HOLDER_A) == 750 ether, "current holder A balance");
        require(fractions.getPastBalance(HOLDER_A, snapshot) == 250 ether, "history mutated");
    }

    function testClaimIsSingleUseAndZeroBalanceHolderCannotClaim() public {
        uint256 distributionId = _createDistribution(keccak256("single-claim"), 1_000 ether);
        VM.prank(HOLDER_A);
        distributor.claim(distributionId);

        VM.prank(HOLDER_A);
        (bool claimedTwice,) =
            address(distributor).call(abi.encodeCall(distributor.claim, (distributionId)));
        require(!claimedTwice, "holder claimed twice");

        VM.prank(OUTSIDER);
        (bool zeroHolderClaimed,) =
            address(distributor).call(abi.encodeCall(distributor.claim, (distributionId)));
        require(!zeroHolderClaimed, "zero-balance holder claimed");
    }

    function testDistributionRequestReplayAndConflict() public {
        bytes32 requestId = keccak256("distribution-replay");
        uint256 balanceBefore = revenue.balanceOf(address(this));
        uint256 first = _createDistribution(requestId, 1_000 ether);
        uint256 replay = distributor.createDistribution(requestId, revenue, 1_000 ether, snapshot);
        require(first == replay, "replay changed distribution id");
        require(
            revenue.balanceOf(address(this)) == balanceBefore - 1_000 ether,
            "replay pulled revenue twice"
        );

        (bool conflict,) = address(distributor)
            .call(
                abi.encodeCall(
                    distributor.createDistribution, (requestId, revenue, 1_001 ether, snapshot)
                )
            );
        require(!conflict, "conflicting distribution replay accepted");
    }

    function testUnauthorizedFundingAndFutureSnapshotFailClosed() public {
        VM.prank(OUTSIDER);
        (bool unauthorized,) = address(distributor)
            .call(
                abi.encodeCall(
                    distributor.createDistribution,
                    (keccak256("unauthorized"), revenue, 1_000 ether, snapshot)
                )
            );
        require(!unauthorized, "unauthorized distribution created");

        (bool futureSnapshot,) = address(distributor)
            .call(
                abi.encodeCall(
                    distributor.createDistribution,
                    (keccak256("future"), revenue, 1_000 ether, uint48(block.number))
                )
            );
        require(!futureSnapshot, "current-block snapshot accepted");
    }

    function testFeeOnTransferRevenueIsRejectedWithoutRoundCreation() public {
        FeeRevenuePaymentToken feeToken = new FeeRevenuePaymentToken();
        feeToken.mint(address(this), 1_000 ether);
        feeToken.approve(address(distributor), type(uint256).max);
        (bool ok,) = address(distributor)
            .call(
                abi.encodeCall(
                    distributor.createDistribution,
                    (keccak256("fee-token"), feeToken, 1_000 ether, snapshot)
                )
            );
        require(!ok, "fee-on-transfer revenue accepted");
        require(distributor.distributionCount() == 0, "failed funding created round");
    }

    function testOutboundFeeRevenueRevertsClaimAndAccounting() public {
        OutboundFeeRevenuePaymentToken feeToken =
            new OutboundFeeRevenuePaymentToken(address(distributor));
        feeToken.mint(address(this), 1_000 ether);
        feeToken.approve(address(distributor), type(uint256).max);
        uint256 distributionId = distributor.createDistribution(
            keccak256("outbound-fee"), feeToken, 1_000 ether, snapshot
        );

        VM.prank(HOLDER_A);
        (bool ok,) = address(distributor).call(abi.encodeCall(distributor.claim, (distributionId)));
        require(!ok, "outbound fee claim accepted");
        require(!distributor.claimed(distributionId, HOLDER_A), "failed claim marked claimed");
        require(distributor.totalClaimed(distributionId) == 0, "failed claim changed ledger");
        require(feeToken.balanceOf(HOLDER_A) == 0, "failed claim paid partial amount");
        require(
            feeToken.balanceOf(address(distributor)) == 1_000 ether, "failed claim reduced custody"
        );
    }

    function testRoundingDustIsBoundedAndCannotBeSwept() public {
        uint256 distributionId = _createDistribution(keccak256("rounding-dust"), 10);
        VM.prank(HOLDER_A);
        distributor.claim(distributionId);
        VM.prank(HOLDER_B);
        distributor.claim(distributionId);
        distributor.claim(distributionId);

        uint256 dust = distributor.remainingRevenue(distributionId);
        require(dust == 1, "unexpected rounding dust");
        require(dust < 3, "dust exceeds nonzero-holder bound");
        require(
            revenue.balanceOf(address(distributor)) == dust, "dust not retained for immutable round"
        );

        (bool swept,) = address(distributor)
            .call(
                abi.encodeWithSignature(
                    "sweep(address,address,uint256)", revenue, address(this), dust
                )
            );
        require(!swept, "unauthorized sweep surface exists");
        require(revenue.balanceOf(address(distributor)) == dust, "sweep changed retained dust");
    }

    function testFuzzProRataClaimsNeverExceedRevenue(uint96 rawRevenue) public {
        uint256 amount = uint256(rawRevenue) % 1_000_000 ether + 4;
        uint256 distributionId =
            _createDistribution(keccak256(abi.encode("fuzz-revenue", rawRevenue)), amount);
        uint256 expectedA = Math.mulDiv(amount, 250 ether, 1_000 ether);
        uint256 expectedB = expectedA;
        uint256 expectedOwner = Math.mulDiv(amount, 500 ether, 1_000 ether);

        VM.prank(HOLDER_A);
        distributor.claim(distributionId);
        VM.prank(HOLDER_B);
        distributor.claim(distributionId);
        distributor.claim(distributionId);

        require(revenue.balanceOf(HOLDER_A) == expectedA, "fuzz holder A claim");
        require(revenue.balanceOf(HOLDER_B) == expectedB, "fuzz holder B claim");
        require(
            distributor.totalClaimed(distributionId) == expectedA + expectedB + expectedOwner,
            "fuzz claim accounting"
        );
        require(distributor.totalClaimed(distributionId) <= amount, "fuzz over-distribution");
    }

    function invariant_ClaimsNeverExceedFundedRevenue() public view {
        require(
            invariantHandler.claimedAmount() <= invariantHandler.funded(),
            "invariant distributed excess revenue"
        );
        require(
            revenue.balanceOf(address(distributor)) + invariantHandler.claimedAmount()
                == invariantHandler.funded(),
            "invariant revenue accounting mismatch"
        );
    }

    function afterInvariant() public view {
        require(invariantHandler.callCount() > 0, "invariant handler was not called");
    }

    function _createDistribution(bytes32 requestId, uint256 amount)
        private
        returns (uint256 distributionId)
    {
        distributionId = distributor.createDistribution(requestId, revenue, amount, snapshot);
    }
}
