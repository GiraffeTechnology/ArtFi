// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FractionalToken} from "../src/FractionalToken.sol";
import {IHistoricalFractionToken, RevenueDistributor} from "../src/RevenueDistributor.sol";

interface RevenueSequenceVm {
    function prank(address sender) external;
    function roll(uint256 blockNumber) external;
}

contract RevenueSequenceToken is ERC20 {
    constructor() ERC20("Sequence payout", "SEQ") {
        _mint(msg.sender, 1e30);
    }
}

/// @dev Bounded stateful model. Snapshot rights are recorded from live balances before
/// closing their block, independently of the distributor's historical-reader result.
contract RevenueSequenceHandler {
    RevenueSequenceVm private constant VM =
        RevenueSequenceVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant SUPPLY = 1000;
    uint256 public constant MAX_ROUNDS = 12;
    uint256 public constant INITIAL_PAYOUT = 1e30;
    FractionalToken public fractions;
    RevenueDistributor public distributor;
    RevenueSequenceToken[2] public payouts;
    address[3] public actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    uint256 public roundCount;
    uint256[2] public funded;
    uint256[2] public paid;
    uint256[2][3] public earned;

    struct Round {
        uint256 id;
        uint256 amount;
        uint48 snapshot;
        uint8 tokenIndex;
        uint256[3] rights;
        bool[3] paid;
    }
    mapping(uint256 => Round) private rounds;

    constructor() {
        fractions =
            new FractionalToken("Sequence fractions", "SF", address(this), SUPPLY, address(this));
        distributor = new RevenueDistributor(
            IHistoricalFractionToken(address(fractions)), address(this), address(this)
        );
        payouts[0] = new RevenueSequenceToken();
        payouts[1] = new RevenueSequenceToken();
        payouts[0].approve(address(distributor), type(uint256).max);
        payouts[1].approve(address(distributor), type(uint256).max);
        require(fractions.transfer(actors[0], 333));
        require(fractions.transfer(actors[1], 333));
        require(fractions.transfer(actors[2], 334));
        fundRound(1001, false);
        fundRound(2003, true);
    }

    function fundRound(uint96 rawAmount, bool secondToken) public {
        if (roundCount == MAX_ROUNDS) return;
        uint256 amount = 1 + uint256(rawAmount) % 1e18;
        uint256 index = roundCount++;
        Round storage round = rounds[index];
        round.amount = amount;
        round.tokenIndex = secondToken ? 1 : 0;
        round.snapshot = uint48(block.number);
        for (uint256 i; i < 3; ++i) {
            round.rights[i] = amount * fractions.balanceOf(actors[i]) / SUPPLY;
        }
        VM.roll(block.number + 1);
        round.id = distributor.createDistribution(
            _request(index), payouts[round.tokenIndex], amount, round.snapshot
        );
        funded[round.tokenIndex] += amount;
    }

    function moveFractions(uint8 rawFrom, uint8 rawTo, uint96 rawAmount) external {
        address from = actors[uint256(rawFrom) % 3];
        address to = actors[uint256(rawTo) % 3];
        uint256 balance = fractions.balanceOf(from);
        if (from == to || balance == 0) return;
        uint256 amount = 1 + uint256(rawAmount) % balance;
        VM.prank(from);
        require(fractions.transfer(to, amount));
        VM.roll(block.number + 1);
    }

    function claimRound(uint8 rawRound, uint8 rawActor) external {
        _claim(uint256(rawRound) % roundCount, uint256(rawActor) % 3);
    }

    function replayRound(uint8 rawRound) external {
        uint256 index = uint256(rawRound) % roundCount;
        Round storage round = rounds[index];
        IERC20 token = payouts[round.tokenIndex];
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 beforeCustody = token.balanceOf(address(distributor));
        require(
            distributor.createDistribution(_request(index), token, round.amount, round.snapshot)
                == round.id,
            "replay ID"
        );
        require(token.balanceOf(address(this)) == beforeBalance, "replay funded again");
        require(token.balanceOf(address(distributor)) == beforeCustody, "replay custody");
        require(distributor.distributionCount() == roundCount, "replay count");
    }

    function repeatClaim(uint8 rawRound, uint8 rawActor) external {
        Round storage round = rounds[uint256(rawRound) % roundCount];
        uint256 actorIndex = uint256(rawActor) % 3;
        if (!round.paid[actorIndex]) return;
        address actor = actors[actorIndex];
        IERC20 token = payouts[round.tokenIndex];
        uint256 beforeBalance = token.balanceOf(actor);
        uint256 beforeTotal = distributor.totalClaimed(round.id);
        VM.prank(actor);
        (bool ok, bytes memory reason) =
            address(distributor).call(abi.encodeCall(distributor.claim, (round.id)));
        require(
            !ok && bytes4(reason) == RevenueDistributor.AlreadyClaimed.selector, "repeat accepted"
        );
        require(
            token.balanceOf(actor) == beforeBalance
                && distributor.totalClaimed(round.id) == beforeTotal,
            "repeat mutated"
        );
    }

    function assertConservation() external view {
        for (uint256 tokenIndex; tokenIndex < 2; ++tokenIndex) {
            uint256 totalEarned;
            for (uint256 actorIndex; actorIndex < 3; ++actorIndex) {
                require(
                    payouts[tokenIndex].balanceOf(actors[actorIndex])
                        == earned[actorIndex][tokenIndex],
                    "holder payout drift"
                );
                totalEarned += earned[actorIndex][tokenIndex];
            }
            require(
                totalEarned == paid[tokenIndex] && paid[tokenIndex] <= funded[tokenIndex],
                "payout conservation"
            );
            require(
                payouts[tokenIndex].balanceOf(address(this)) + funded[tokenIndex] == INITIAL_PAYOUT,
                "funding conservation"
            );
            require(
                payouts[tokenIndex].balanceOf(address(distributor)) + paid[tokenIndex]
                    == funded[tokenIndex],
                "custody conservation"
            );
        }
        uint256 balances;
        for (uint256 i; i < 3; ++i) {
            balances += fractions.balanceOf(actors[i]);
        }
        require(balances == SUPPLY && fractions.totalSupply() == SUPPLY, "fraction conservation");
    }

    function assertSnapshotRights() external view {
        require(distributor.distributionCount() == roundCount, "round count drift");
        uint256[2] memory remainderByToken;
        for (uint256 index; index < roundCount; ++index) {
            Round storage round = rounds[index];
            (IERC20 token, uint256 amount, uint256 supply, uint48 snapshot) =
                distributor.distributions(round.id);
            require(
                address(token) == address(payouts[round.tokenIndex]) && amount == round.amount
                    && supply == SUPPLY && snapshot == round.snapshot,
                "immutable round drift"
            );
            uint256 roundPaid;
            for (uint256 i; i < 3; ++i) {
                require(
                    distributor.claimed(round.id, actors[i]) == round.paid[i], "claim flag drift"
                );
                require(
                    distributor.claimable(round.id, actors[i])
                        == (round.paid[i] ? 0 : round.rights[i]),
                    "snapshot rights drift"
                );
                if (round.paid[i]) roundPaid += round.rights[i];
            }
            require(distributor.totalClaimed(round.id) == roundPaid, "round payment drift");
            require(
                distributor.remainingRevenue(round.id) == round.amount - roundPaid,
                "round remainder drift"
            );
            remainderByToken[round.tokenIndex] += round.amount - roundPaid;
        }
        for (uint256 i; i < 2; ++i) {
            require(
                remainderByToken[i] == payouts[i].balanceOf(address(distributor)),
                "round custody drift"
            );
        }
    }

    function finishAndAssertDust() external {
        for (uint256 index; index < roundCount; ++index) {
            for (uint256 i; i < 3; ++i) {
                _claim(index, i);
            }
            require(distributor.remainingRevenue(rounds[index].id) < 3, "excess rounding dust");
        }
        this.assertConservation();
        this.assertSnapshotRights();
    }

    function _claim(uint256 index, uint256 actorIndex) private {
        Round storage round = rounds[index];
        if (round.paid[actorIndex] || round.rights[actorIndex] == 0) return;
        VM.prank(actors[actorIndex]);
        uint256 amount = distributor.claim(round.id);
        require(amount == round.rights[actorIndex], "claim entitlement drift");
        round.paid[actorIndex] = true;
        earned[actorIndex][round.tokenIndex] += amount;
        paid[round.tokenIndex] += amount;
    }

    function _request(uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encode("stateful-revenue-round", index));
    }
}

contract RevenueStatefulInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    RevenueSequenceHandler private handler;

    function setUp() public {
        handler = new RevenueSequenceHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.fundRound.selector;
        selectors[1] = handler.moveFractions.selector;
        selectors[2] = handler.claimRound.selector;
        selectors[3] = handler.replayRound.selector;
        selectors[4] = handler.repeatClaim.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantPayoutAndCustodyConservation() public view {
        handler.assertConservation();
    }

    function invariantImmutableHistoricalRights() public view {
        handler.assertSnapshotRights();
    }

    function afterInvariant() public {
        handler.finishAndAssertDust();
    }
}
