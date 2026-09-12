// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiMarket} from "../src/ArtFiMarket.sol";

interface MarketVm {
    function envAddress(string calldata name) external view returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only ArtFiMarket deployment. Signing remains external to this source.
/// @dev Opt-in. `sepolia-deploy.sh` runs this only when ARTFI_DEPLOY_MARKET=true, and
///      `sepolia-preflight.sh` fails closed unless every setting below is supplied
///      explicitly. Nothing here carries a repository default: an operator who omits a
///      role address gets a refusal, never an implicit deployer-owned market.
contract DeployMarket {
    MarketVm private constant VM =
        MarketVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();

    function run() external returns (ArtFiMarket market) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);
        address admin = VM.envAddress("ARTFI_MARKET_ADMIN");
        address pauser = VM.envAddress("ARTFI_MARKET_PAUSER");
        address tokenManager = VM.envAddress("ARTFI_MARKET_TOKEN_MANAGER");
        if (admin == address(0) || pauser == address(0) || tokenManager == address(0)) {
            revert ZeroAddress();
        }

        VM.startBroadcast();
        market = new ArtFiMarket(admin, pauser, tokenManager);
        VM.stopBroadcast();
    }
}
