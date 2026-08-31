// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AdminSafeDeploymentPolicy} from "../src/AdminSafeDeploymentPolicy.sol";
import {ArtFiCharityEditions} from "../src/ArtFiCharityEditions.sol";

interface VmCharityEditions {
    function envAddress(string calldata name) external view returns (address value);
    function envBytes32(string calldata name) external view returns (bytes32 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Optional Hoodi-only deployment for the separately gated ArtCCH charity editions.
/// @dev The signing method is supplied to Forge and no key is read or stored by this source.
contract DeployCharityEditions {
    VmCharityEditions private constant VM =
        VmCharityEditions(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();
    error RoleHandoffFailed();

    function run() external returns (ArtFiCharityEditions editions) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);

        address adminSafe = VM.envAddress("ARTFI_ADMIN_SAFE");
        bytes32 adminSafeCodehash = VM.envBytes32("ARTFI_ADMIN_SAFE_CODEHASH");
        if (adminSafe == address(0)) revert ZeroAddress();
        AdminSafeDeploymentPolicy.validate(adminSafe, adminSafeCodehash);

        VM.startBroadcast();
        editions = _deploy(adminSafe);
        VM.stopBroadcast();
    }

    function _deploy(address adminSafe) internal returns (ArtFiCharityEditions editions) {
        AdminSafeDeploymentPolicy.validate(adminSafe, adminSafe.codehash);
        editions = new ArtFiCharityEditions(adminSafe, adminSafe, adminSafe, adminSafe);
        if (
            !editions.hasRole(editions.DEFAULT_ADMIN_ROLE(), adminSafe)
                || !editions.hasRole(editions.SERIES_CREATOR_ROLE(), adminSafe)
                || !editions.hasRole(editions.DONATION_RECORDER_ROLE(), adminSafe)
                || !editions.hasRole(editions.PAUSER_ROLE(), adminSafe)
        ) {
            revert RoleHandoffFailed();
        }
    }
}
