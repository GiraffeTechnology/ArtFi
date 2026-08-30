// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IArtFiBuyoutPriceVerifier} from "../src/ArtFiDAOActions.sol";
import {ArtFiGovernanceBootstrap} from "../src/ArtFiGovernanceBootstrap.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";

interface Stage4Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envUint(string calldata name) external view returns (uint256 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only self-administered governance deployment.
/// @dev ArtFi exchange deployment is intentionally excluded until the compliance launch gate is approved.
contract DeployStage4 {
    Stage4Vm private constant VM =
        Stage4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error InvalidConfiguration();
    error UnsupportedChain(uint256 chainId);

    function run() external returns (ArtFiGovernanceBootstrap governance) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);
        address rwaVault = VM.envAddress("ARTFI_RWA_VAULT");
        address buyoutPriceVerifier = VM.envAddress("ARTFI_BUYOUT_PRICE_VERIFIER");
        uint256 delay = VM.envUint("ARTFI_TIMELOCK_DELAY_SECONDS");
        uint256 votingDelay = VM.envUint("ARTFI_VOTING_DELAY_BLOCKS");
        uint256 votingPeriod = VM.envUint("ARTFI_VOTING_PERIOD_BLOCKS");
        uint256 quorum = VM.envUint("ARTFI_QUORUM_PERCENT");
        if (
            rwaVault == address(0) || buyoutPriceVerifier == address(0)
                || votingDelay > type(uint48).max || votingPeriod == 0
                || votingPeriod > type(uint32).max || quorum == 0 || quorum > 100
        ) revert InvalidConfiguration();

        VM.startBroadcast();
        governance = new ArtFiGovernanceBootstrap(
            ArtFiVault(rwaVault),
            IArtFiBuyoutPriceVerifier(buyoutPriceVerifier),
            delay,
            uint48(votingDelay),
            uint32(votingPeriod),
            quorum
        );
        VM.stopBroadcast();
    }
}
