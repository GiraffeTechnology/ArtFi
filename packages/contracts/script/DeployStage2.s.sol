// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {AdminSafeDeploymentPolicy} from "../src/AdminSafeDeploymentPolicy.sol";
import {RWARegistry} from "../src/RWARegistry.sol";

interface Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envBytes32(string calldata name) external view returns (bytes32 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only deployment script. The signing method is supplied by forge at runtime;
///         this source never reads or stores a private key.
contract DeployStage2 {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();
    error BootstrapDeployerIsAdminSafe();
    error RoleHandoffFailed();

    function run() external returns (ArtFiRWA nft, RWARegistry registry) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);

        address deployer = VM.envAddress("DEPLOYER_ADDRESS");
        address adminSafe = VM.envAddress("ARTFI_ADMIN_SAFE");
        bytes32 adminSafeCodehash = VM.envBytes32("ARTFI_ADMIN_SAFE_CODEHASH");
        if (deployer == address(0)) revert ZeroAddress();
        if (deployer == adminSafe) revert BootstrapDeployerIsAdminSafe();
        AdminSafeDeploymentPolicy.validate(adminSafe, adminSafeCodehash);

        VM.startBroadcast();
        (nft, registry) = _deploy(adminSafe, deployer);
        VM.stopBroadcast();
    }

    function _deploy(address adminSafe, address deployer)
        internal
        returns (ArtFiRWA nft, RWARegistry registry)
    {
        AdminSafeDeploymentPolicy.validate(adminSafe, adminSafe.codehash);

        nft = new ArtFiRWA("ArtFi RWA", "ARWA", deployer, deployer, deployer);
        registry = new RWARegistry(nft, adminSafe, adminSafe, adminSafe);

        nft.grantRole(nft.MINTER_ROLE(), address(registry));
        nft.revokeRole(nft.MINTER_ROLE(), deployer);
        nft.grantRole(nft.PAUSER_ROLE(), adminSafe);
        nft.revokeRole(nft.PAUSER_ROLE(), deployer);
        nft.grantRole(nft.DEFAULT_ADMIN_ROLE(), adminSafe);
        nft.renounceRole(nft.DEFAULT_ADMIN_ROLE(), deployer);

        if (
            !nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), adminSafe)
                || !nft.hasRole(nft.PAUSER_ROLE(), adminSafe)
                || !nft.hasRole(nft.MINTER_ROLE(), address(registry))
                || nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), deployer)
                || nft.hasRole(nft.PAUSER_ROLE(), deployer)
                || nft.hasRole(nft.MINTER_ROLE(), deployer)
                || !registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), adminSafe)
                || !registry.hasRole(registry.REGISTRAR_ROLE(), adminSafe)
                || !registry.hasRole(registry.PAUSER_ROLE(), adminSafe)
        ) {
            revert RoleHandoffFailed();
        }
    }
}
