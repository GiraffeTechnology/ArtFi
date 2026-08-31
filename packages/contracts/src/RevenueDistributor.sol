// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IHistoricalFractionToken {
    function clock() external view returns (uint48);
    function getPastBalance(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
}

/// @title ArtFi snapshot revenue distributor
/// @notice Funds immutable rounds and lets fraction holders pull their pro-rata revenue claim.
contract RevenueDistributor is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    struct Distribution {
        IERC20 payoutToken;
        uint256 revenueAmount;
        uint256 snapshotSupply;
        uint48 snapshotTimepoint;
    }

    error AlreadyClaimed();
    error AmountUnavailable();
    error IdempotencyConflict(bytes32 requestId);
    error InvalidConfiguration();
    error TransferAmountMismatch();
    error ZeroAddress();

    event DistributionCreated(
        bytes32 indexed requestId,
        uint256 indexed distributionId,
        address indexed payoutToken,
        uint256 revenueAmount,
        uint48 snapshotTimepoint,
        uint256 snapshotSupply
    );
    event RevenueClaimed(
        uint256 indexed distributionId,
        address indexed account,
        address indexed payoutToken,
        uint256 amount
    );

    IHistoricalFractionToken public immutable fractionToken;
    mapping(uint256 distributionId => Distribution distribution) public distributions;
    mapping(uint256 distributionId => mapping(address account => bool claimed)) public claimed;
    mapping(uint256 distributionId => uint256 amount) public totalClaimed;

    mapping(bytes32 requestId => uint256 distributionId) private _distributionByRequest;
    mapping(bytes32 requestId => bytes32 intentHash) private _distributionIntent;
    uint256 public distributionCount;

    constructor(IHistoricalFractionToken fractionToken_, address admin, address distributor) {
        if (
            address(fractionToken_) == address(0) || admin == address(0)
                || distributor == address(0)
        ) {
            revert ZeroAddress();
        }
        fractionToken = fractionToken_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DISTRIBUTOR_ROLE, distributor);
    }

    function createDistribution(
        bytes32 requestId,
        IERC20 payoutToken,
        uint256 revenueAmount,
        uint48 snapshotTimepoint
    ) external onlyRole(DISTRIBUTOR_ROLE) nonReentrant returns (uint256 distributionId) {
        if (
            requestId == bytes32(0) || address(payoutToken) == address(0) || revenueAmount == 0
                || snapshotTimepoint >= fractionToken.clock()
        ) revert InvalidConfiguration();

        uint256 snapshotSupply = fractionToken.getPastTotalSupply(snapshotTimepoint);
        if (snapshotSupply == 0) revert InvalidConfiguration();
        bytes32 intentHash = keccak256(
            abi.encode(msg.sender, payoutToken, revenueAmount, snapshotTimepoint, snapshotSupply)
        );
        distributionId = _distributionByRequest[requestId];
        if (distributionId != 0) {
            if (_distributionIntent[requestId] != intentHash) {
                revert IdempotencyConflict(requestId);
            }
            return distributionId;
        }

        _pullExact(payoutToken, msg.sender, revenueAmount);
        distributionId = ++distributionCount;
        _distributionByRequest[requestId] = distributionId;
        _distributionIntent[requestId] = intentHash;
        distributions[distributionId] = Distribution({
            payoutToken: payoutToken,
            revenueAmount: revenueAmount,
            snapshotSupply: snapshotSupply,
            snapshotTimepoint: snapshotTimepoint
        });
        emit DistributionCreated(
            requestId,
            distributionId,
            address(payoutToken),
            revenueAmount,
            snapshotTimepoint,
            snapshotSupply
        );
    }

    function claim(uint256 distributionId) external nonReentrant returns (uint256 amount) {
        Distribution storage distribution = distributions[distributionId];
        if (address(distribution.payoutToken) == address(0)) revert InvalidConfiguration();
        if (claimed[distributionId][msg.sender]) revert AlreadyClaimed();
        uint256 snapshotBalance =
            fractionToken.getPastBalance(msg.sender, distribution.snapshotTimepoint);
        amount =
            Math.mulDiv(distribution.revenueAmount, snapshotBalance, distribution.snapshotSupply);
        if (amount == 0) revert AmountUnavailable();

        claimed[distributionId][msg.sender] = true;
        totalClaimed[distributionId] += amount;
        _pushExact(distribution.payoutToken, msg.sender, amount);
        emit RevenueClaimed(distributionId, msg.sender, address(distribution.payoutToken), amount);
    }

    /// @notice Revenue still held for pending claims or indivisible rounding dust.
    /// @dev There is deliberately no sweep path: claim rights remain available indefinitely.
    function remainingRevenue(uint256 distributionId) external view returns (uint256) {
        Distribution storage distribution = distributions[distributionId];
        if (address(distribution.payoutToken) == address(0)) revert InvalidConfiguration();
        return distribution.revenueAmount - totalClaimed[distributionId];
    }

    function claimable(uint256 distributionId, address account) external view returns (uint256) {
        Distribution storage distribution = distributions[distributionId];
        if (address(distribution.payoutToken) == address(0) || claimed[distributionId][account]) {
            return 0;
        }
        return Math.mulDiv(
            distribution.revenueAmount,
            fractionToken.getPastBalance(account, distribution.snapshotTimepoint),
            distribution.snapshotSupply
        );
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) {
            revert TransferAmountMismatch();
        }
    }

    function _pushExact(IERC20 token, address recipient, uint256 amount) private {
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 senderAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderAfter > senderBefore || senderBefore - senderAfter != amount
                || recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount
        ) revert TransferAmountMismatch();
    }
}
