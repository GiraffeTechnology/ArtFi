// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {FractionalToken} from "../src/FractionalToken.sol";
import {IHistoricalFractionToken, RevenueDistributor} from "../src/RevenueDistributor.sol";

interface FundingAccountingVm {
    function prank(address sender) external;
    function roll(uint256 number) external;
}

/// @dev TEST_ONLY transfer modes. No external chain or production asset is used.
contract FundingAccountingToken is ERC20 {
    address private immutable pool;
    uint8 public mode;

    constructor(address pool_) ERC20("Accounting fixture", "ACCT") {
        pool = pool_;
    }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setMode(uint8 next) external {
        mode = next;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to != pool || mode == 0) {
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

contract RevenueFundingAccountingTest {
    FundingAccountingVm private constant VM =
        FundingAccountingVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant HOLDER = address(0xA11CE);
    FractionalToken private fractions;
    RevenueDistributor private distributor;
    FundingAccountingToken private payment;
    uint48 private snapshot;

    function setUp() public {
        fractions =
            new FractionalToken("Accounting fractions", "AF", address(this), 1000, address(this));
        distributor = new RevenueDistributor(
            IHistoricalFractionToken(address(fractions)), address(this), address(this)
        );
        payment = new FundingAccountingToken(address(distributor));
        payment.mint(address(this), 10 ** 30);
        payment.approve(address(distributor), type(uint256).max);
        require(fractions.transfer(HOLDER, 250), "fraction allocation");
        snapshot = uint48(block.number);
        VM.roll(block.number + 1);
    }

    function testSenderFeeFundingRejected() public {
        uint256 first = _seed();
        uint256 beforeBalance = payment.balanceOf(address(this));
        payment.approve(address(distributor), 100);
        payment.setMode(1);
        _expectRejected(keccak256("sender-fee"), 100);
        require(payment.balanceOf(address(this)) == beforeBalance, "payer fee escaped rollback");
        require(payment.allowance(address(this), address(distributor)) == 100, "allowance consumed");
        _assertSeedUnchanged(first);
    }

    function testSenderRebateFundingRejected() public {
        uint256 first = _seed();
        uint256 beforeBalance = payment.balanceOf(address(this));
        payment.setMode(5);
        _expectRejected(keccak256("sender-rebate"), 100);
        require(payment.balanceOf(address(this)) == beforeBalance, "rebate escaped rollback");
        _assertSeedUnchanged(first);
    }

    function testReceiverDecreaseReturnsAmountMismatch() public {
        uint256 first = _seed();
        uint256 beforeBalance = payment.balanceOf(address(this));
        payment.setMode(4);
        _expectRejected(keccak256("receiver-decrease"), 100);
        require(payment.balanceOf(address(this)) == beforeBalance, "payer debit escaped rollback");
        _assertSeedUnchanged(first);
    }

    function testBonusCreditRejectedWithoutConsumingExistingRound() public {
        uint256 first = _seed();
        payment.setMode(3);
        _expectRejected(keccak256("receiver-bonus"), 100);
        _assertSeedUnchanged(first);
    }

    function testExactFundingDebitsAndCreditsOnlyAgreedAmount() public {
        uint256 beforeBalance = payment.balanceOf(address(this));
        uint256 id = _fund(keccak256("exact"), 100);
        require(payment.balanceOf(address(this)) == beforeBalance - 100, "payer amount");
        require(payment.balanceOf(address(distributor)) == 100, "pool amount");
        VM.prank(HOLDER);
        require(distributor.claim(id) == 25, "holder claim");
        require(distributor.claim(id) == 75, "owner claim");
        require(distributor.totalClaimed(id) == 100, "claim accounting");
        require(distributor.remainingRevenue(id) == 0, "round not drained");
    }

    function testRejectedFundingCanRetrySameRequestExactlyOnce() public {
        uint256 first = _seed();
        bytes32 requestId = keccak256("retry-exact");
        payment.setMode(1);
        _expectRejected(requestId, 100);
        _assertSeedUnchanged(first);
        payment.setMode(0);
        uint256 second = _fund(requestId, 100);
        require(second == 2, "failed request consumed identifier");
        uint256 beforeReplay = payment.balanceOf(address(this));
        require(_fund(requestId, 100) == second, "replay changed round");
        require(payment.balanceOf(address(this)) == beforeReplay, "replay debited again");
        require(payment.balanceOf(address(distributor)) == 1100, "pooled funding");
        VM.prank(HOLDER);
        distributor.claim(first);
        VM.prank(HOLDER);
        distributor.claim(second);
        require(payment.balanceOf(HOLDER) == 275, "cross-round claim");
        require(distributor.remainingRevenue(first) == 750, "old round changed");
        require(distributor.remainingRevenue(second) == 75, "new round changed");
        require(payment.balanceOf(address(distributor)) == 825, "pooled remainder");
    }

    function testFuzzNonExactFundingRollsBackAllAccounting(uint96 rawAmount, uint8 rawMode) public {
        uint256 first = _seed();
        uint256 amount = uint256(rawAmount) % 10 ** 18 + 2;
        uint256 beforeBalance = payment.balanceOf(address(this));
        payment.approve(address(distributor), amount);
        payment.setMode(rawMode % 5 + 1);
        _expectRejected(keccak256(abi.encode("non-exact", rawAmount, rawMode)), amount);
        require(payment.balanceOf(address(this)) == beforeBalance, "payer changed after failure");
        require(
            payment.allowance(address(this), address(distributor)) == amount, "allowance changed"
        );
        _assertSeedUnchanged(first);
    }

    function _seed() private returns (uint256) {
        return _fund(keccak256("existing-round"), 1000);
    }

    function _fund(bytes32 requestId, uint256 amount) private returns (uint256) {
        return distributor.createDistribution(requestId, payment, amount, snapshot);
    }

    function _expectRejected(bytes32 requestId, uint256 amount) private {
        (bool ok, bytes memory reason) = address(distributor)
            .call(
                abi.encodeCall(
                    distributor.createDistribution, (requestId, payment, amount, snapshot)
                )
            );
        require(!ok, "non-exact funding accepted");
        require(
            reason.length >= 4
                && bytes4(reason) == RevenueDistributor.TransferAmountMismatch.selector,
            "wrong failure type"
        );
    }

    function _assertSeedUnchanged(uint256 first) private view {
        require(distributor.distributionCount() == 1, "failed funding created a round");
        require(distributor.totalClaimed(first) == 0, "existing claims changed");
        require(distributor.remainingRevenue(first) == 1000, "existing revenue changed");
        require(distributor.claimable(first, HOLDER) == 250, "existing entitlement changed");
        require(payment.balanceOf(address(distributor)) == 1000, "existing pool changed");
    }
}
