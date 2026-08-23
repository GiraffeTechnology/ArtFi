// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiCharityEditions} from "../src/ArtFiCharityEditions.sol";

interface VmCharityEditions {
    function envAddress(string calldata name) external view returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Optional testnet-only deployment for the separately gated ArtCCH charity editions.
/// @dev The signing method is supplied to Forge and no key is read or stored by this source.
contract DeployCharityEditions {
    VmCharityEditions private constant VM =
        VmCharityEditions(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SEPOLIA_CHAIN_ID = 11_155_111;
    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    error SupportedTestnetOnly(uint256 chainId);
    error ZeroAddress();

    function run() external returns (ArtFiCharityEditions editions) {
        if (block.chainid != SEPOLIA_CHAIN_ID && block.chainid != BASE_SEPOLIA_CHAIN_ID) {
            revert SupportedTestnetOnly(block.chainid);
        }

        address admin = VM.envAddress("ARTFI_ADMIN");
        address seriesCreator = VM.envAddress("ARTFI_EDITION_CREATOR");
        address donationRecorder = VM.envAddress("ARTFI_DONATION_RECORDER");
        address pauser = VM.envAddress("ARTFI_PAUSER");
        if (
            admin == address(0) || seriesCreator == address(0) || donationRecorder == address(0)
                || pauser == address(0)
        ) revert ZeroAddress();

        VM.startBroadcast();
        editions = new ArtFiCharityEditions(admin, seriesCreator, donationRecorder, pauser);
        VM.stopBroadcast();
    }
}
