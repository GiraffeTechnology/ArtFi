// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiHoodiTestNFT} from "../src/test-only/ArtFiHoodiTestNFT.sol";

interface VmHoodiTestNFT {
    function envAddress(string calldata name) external view returns (address value);
    function envBytes32(string calldata name) external view returns (bytes32 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Optional isolated test deployment; an existing controlled signer is supplied to Forge.
/// @dev This source reads no key and supplies no default issuer, task identity or endpoint.
contract DeployArtFiHoodiTestNFT {
    VmHoodiTestNFT private constant VM = VmHoodiTestNFT(address(uint160(uint256(keccak256("hevm cheat code")))));

    error UnsupportedChain(uint256 chainId);
    error InvalidBinding();

    function run() external returns (ArtFiHoodiTestNFT collection) {
        if (block.chainid != 560_048) revert UnsupportedChain(block.chainid);
        address issuer = VM.envAddress("ARTFI_TEST_NFT_ISSUER");
        bytes32 taskId = VM.envBytes32("ARTFI_TEST_NFT_TASK_ID");
        if (issuer == address(0) || taskId == bytes32(0)) revert InvalidBinding();
        VM.startBroadcast();
        collection = new ArtFiHoodiTestNFT(issuer, taskId);
        VM.stopBroadcast();
    }
}
