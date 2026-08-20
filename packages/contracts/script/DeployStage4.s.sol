// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {ArtFiGovernanceBootstrap} from "../src/ArtFiGovernanceBootstrap.sol";

interface Stage4Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envUint(string calldata name) external view returns (uint256 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Sepolia-only self-administered governance deployment.
/// @dev ArtFi exchange deployment is intentionally excluded until the compliance launch gate is approved.
contract DeployStage4 {
    Stage4Vm private constant VM =
        Stage4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SEPOLIA_CHAIN_ID = 11_155_111;

    error InvalidConfiguration();
    error SepoliaOnly(uint256 chainId);

    function run() external returns (ArtFiGovernanceBootstrap governance) {
        if (block.chainid != SEPOLIA_CHAIN_ID) revert SepoliaOnly(block.chainid);
        address votingToken = VM.envAddress("ARTFI_GOVERNANCE_TOKEN");
        uint256 delay = VM.envUint("ARTFI_TIMELOCK_DELAY_SECONDS");
        uint256 votingDelay = VM.envUint("ARTFI_VOTING_DELAY_BLOCKS");
        uint256 votingPeriod = VM.envUint("ARTFI_VOTING_PERIOD_BLOCKS");
        uint256 threshold = VM.envUint("ARTFI_PROPOSAL_THRESHOLD");
        uint256 quorum = VM.envUint("ARTFI_QUORUM_PERCENT");
        if (
            votingToken == address(0) || votingDelay > type(uint48).max || votingPeriod == 0
                || votingPeriod > type(uint32).max || quorum == 0 || quorum > 100
        ) revert InvalidConfiguration();

        VM.startBroadcast();
        governance = new ArtFiGovernanceBootstrap(
            IVotes(votingToken), delay, uint48(votingDelay), uint32(votingPeriod), threshold, quorum
        );
        VM.stopBroadcast();
    }
}
