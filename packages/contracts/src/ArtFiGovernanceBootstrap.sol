// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ArtFiDAOActions, IArtFiBuyoutPriceVerifier} from "./ArtFiDAOActions.sol";
import {ArtFiGovernor} from "./ArtFiGovernor.sol";
import {ArtFiVault} from "./ArtFiVault.sol";

/// @title ArtFi Governance Bootstrap
/// @notice Binds one self-administered Governor/Timelock to one NFT-backed ArtFi Vault.
contract ArtFiGovernanceBootstrap {
    uint256 public constant PROPOSAL_THRESHOLD_NUMERATOR = 100_000;
    uint256 public constant OWNERSHIP_DENOMINATOR = 1_000_000;

    ArtFiGovernor public immutable governor;
    TimelockController public immutable timelock;
    ArtFiDAOActions public immutable actionRegistry;

    error InvalidRWA();

    constructor(
        ArtFiVault vault,
        IArtFiBuyoutPriceVerifier buyoutPriceVerifier,
        uint256 timelockDelaySeconds,
        uint48 votingDelayBlocks,
        uint32 votingPeriodBlocks,
        uint256 quorumPercent
    ) {
        uint256 supply = vault.fractionalToken().totalSupply();
        if (supply == 0) revert InvalidRWA();
        uint256 proposalThreshold = Math.mulDiv(
            supply, PROPOSAL_THRESHOLD_NUMERATOR, OWNERSHIP_DENOMINATOR, Math.Rounding.Ceil
        );

        address[] memory noProposers = new address[](0);
        address[] memory openExecutors = new address[](1);
        openExecutors[0] = address(0);
        TimelockController createdTimelock =
            new TimelockController(timelockDelaySeconds, noProposers, openExecutors, address(this));
        ArtFiDAOActions createdActions =
            new ArtFiDAOActions(vault, address(createdTimelock), buyoutPriceVerifier);
        ArtFiGovernor createdGovernor = new ArtFiGovernor(
            vault,
            createdActions,
            createdTimelock,
            votingDelayBlocks,
            votingPeriodBlocks,
            proposalThreshold,
            quorumPercent
        );
        createdTimelock.grantRole(createdTimelock.PROPOSER_ROLE(), address(createdGovernor));
        createdTimelock.grantRole(createdTimelock.CANCELLER_ROLE(), address(createdGovernor));
        createdTimelock.renounceRole(createdTimelock.DEFAULT_ADMIN_ROLE(), address(this));
        timelock = createdTimelock;
        actionRegistry = createdActions;
        governor = createdGovernor;
    }
}
