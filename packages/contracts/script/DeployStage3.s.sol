// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {VaultFactory} from "../src/VaultFactory.sol";

interface Stage3Vm {
    function envAddress(string calldata name) external view returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Sepolia-only VaultFactory deployment. Signing remains external to this source.
contract DeployStage3 {
    Stage3Vm private constant VM =
        Stage3Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SEPOLIA_CHAIN_ID = 11_155_111;

    error SepoliaOnly(uint256 chainId);
    error ZeroAddress();

    function run() external returns (VaultFactory factory) {
        if (block.chainid != SEPOLIA_CHAIN_ID) revert SepoliaOnly(block.chainid);
        address admin = VM.envAddress("ARTFI_ADMIN");
        address creator = VM.envAddress("ARTFI_VAULT_CREATOR");
        address pauser = VM.envAddress("ARTFI_PAUSER");
        if (admin == address(0) || creator == address(0) || pauser == address(0)) {
            revert ZeroAddress();
        }

        VM.startBroadcast();
        factory = new VaultFactory(admin, creator, pauser);
        VM.stopBroadcast();
    }
}
