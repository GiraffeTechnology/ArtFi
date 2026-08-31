// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AdminSafeDeploymentPolicy} from "../src/AdminSafeDeploymentPolicy.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

interface Stage3Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envBytes32(string calldata name) external view returns (bytes32 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only VaultFactory deployment. Signing remains external to this source.
contract DeployStage3 {
    Stage3Vm private constant VM =
        Stage3Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();
    error RoleHandoffFailed();

    function run() external returns (VaultFactory factory) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);
        address adminSafe = VM.envAddress("ARTFI_ADMIN_SAFE");
        bytes32 adminSafeCodehash = VM.envBytes32("ARTFI_ADMIN_SAFE_CODEHASH");
        if (adminSafe == address(0)) revert ZeroAddress();
        AdminSafeDeploymentPolicy.validate(adminSafe, adminSafeCodehash);

        VM.startBroadcast();
        factory = _deploy(adminSafe);
        VM.stopBroadcast();
    }

    function _deploy(address adminSafe) internal returns (VaultFactory factory) {
        AdminSafeDeploymentPolicy.validate(adminSafe, adminSafe.codehash);
        factory = new VaultFactory(adminSafe, adminSafe, adminSafe);
        if (
            !factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), adminSafe)
                || !factory.hasRole(factory.CREATOR_ROLE(), adminSafe)
                || !factory.hasRole(factory.PAUSER_ROLE(), adminSafe)
        ) {
            revert RoleHandoffFailed();
        }
    }
}
