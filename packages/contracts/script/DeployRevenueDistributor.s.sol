// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHistoricalFractionToken, RevenueDistributor} from "../src/RevenueDistributor.sol";

interface RevenueVm {
    function envAddress(string calldata name) external view returns (address value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only RevenueDistributor deployment. Signing remains external to this source.
/// @dev Opt-in and separate from DeployMarket because a distributor is bound to one
///      fraction token at construction: it is per-asset infrastructure, not a one-time
///      deployment. `sepolia-preflight.sh` fails closed unless the fraction token and both
///      role addresses are supplied explicitly.
contract DeployRevenueDistributor {
    RevenueVm private constant VM =
        RevenueVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();

    function run() external returns (RevenueDistributor distributor) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);
        address fractionToken = VM.envAddress("ARTFI_REVENUE_FRACTION_TOKEN");
        address admin = VM.envAddress("ARTFI_REVENUE_ADMIN");
        address distributorRole = VM.envAddress("ARTFI_REVENUE_DISTRIBUTOR");
        if (fractionToken == address(0) || admin == address(0) || distributorRole == address(0)) {
            revert ZeroAddress();
        }

        VM.startBroadcast();
        distributor =
            new RevenueDistributor(IHistoricalFractionToken(fractionToken), admin, distributorRole);
        VM.stopBroadcast();
    }
}
