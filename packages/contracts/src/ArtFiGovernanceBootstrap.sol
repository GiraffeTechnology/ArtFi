// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {ArtFiGovernor} from "./ArtFiGovernor.sol";

/// @title ArtFi Governance Bootstrap
/// @notice Atomically configures Governor/Timelock roles and leaves the Timelock self-administered.
contract ArtFiGovernanceBootstrap {
    ArtFiGovernor public immutable governor;
    TimelockController public immutable timelock;

    constructor(
        IVotes token,
        uint256 timelockDelaySeconds,
        uint48 votingDelayBlocks,
        uint32 votingPeriodBlocks,
        uint256 proposalThresholdTokens,
        uint256 quorumPercent
    ) {
        address[] memory noProposers = new address[](0);
        address[] memory openExecutors = new address[](1);
        openExecutors[0] = address(0);
        TimelockController createdTimelock =
            new TimelockController(timelockDelaySeconds, noProposers, openExecutors, address(this));
        ArtFiGovernor createdGovernor = new ArtFiGovernor(
            token,
            createdTimelock,
            votingDelayBlocks,
            votingPeriodBlocks,
            proposalThresholdTokens,
            quorumPercent
        );
        createdTimelock.grantRole(createdTimelock.PROPOSER_ROLE(), address(createdGovernor));
        createdTimelock.grantRole(createdTimelock.CANCELLER_ROLE(), address(createdGovernor));
        createdTimelock.renounceRole(createdTimelock.DEFAULT_ADMIN_ROLE(), address(this));
        timelock = createdTimelock;
        governor = createdGovernor;
    }
}
