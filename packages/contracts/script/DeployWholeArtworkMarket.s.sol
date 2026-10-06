// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {WholeArtworkMarket} from "../src/WholeArtworkMarket.sol";

interface VmWholeArtworkMarket {
    function envAddress(string calldata name) external view returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only deployment for the whole-artwork signature settlement path.
/// @dev The signing method is supplied to Forge and no key is read or stored by this source.
///      The market is deployed with no collection and no payment token allowed; both are opened
///      afterwards by the token manager, so a fresh deployment can settle nothing until someone
///      with that role decides what it may settle.
contract DeployWholeArtworkMarket {
    VmWholeArtworkMarket private constant VM =
        VmWholeArtworkMarket(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();

    function run() external returns (WholeArtworkMarket market) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);

        address admin = VM.envAddress("ARTFI_ADMIN");
        address pauser = VM.envAddress("ARTFI_PAUSER");
        address tokenManager = VM.envAddress("ARTFI_TOKEN_MANAGER");
        if (admin == address(0) || pauser == address(0) || tokenManager == address(0)) {
            revert ZeroAddress();
        }

        VM.startBroadcast();
        market = new WholeArtworkMarket(admin, pauser, tokenManager);
        VM.stopBroadcast();
    }
}
