// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AdminSafeDeploymentPolicy} from "../src/AdminSafeDeploymentPolicy.sol";
import {ArtFiAdminSafe} from "../src/ArtFiAdminSafe.sol";

interface AdminSafeDeploymentVm {
    function envAddress(string calldata name, string calldata delimiter)
        external
        view
        returns (address[] memory value);
    function envUint(string calldata name) external view returns (uint256 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only deployment of the single administration safe used by all later stages.
contract DeployAdminSafe {
    AdminSafeDeploymentVm private constant VM =
        AdminSafeDeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error DelayOutOfRange(uint256 delaySeconds);
    error UnsupportedChain(uint256 chainId);

    function run() external returns (ArtFiAdminSafe safe) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);
        address[] memory owners_ = VM.envAddress("ARTFI_ADMIN_SAFE_OWNERS", ",");
        uint256 threshold_ = VM.envUint("ARTFI_ADMIN_SAFE_THRESHOLD");
        uint256 delay_ = VM.envUint("ARTFI_ADMIN_SAFE_DELAY_SECONDS");
        if (delay_ > type(uint64).max) revert DelayOutOfRange(delay_);

        VM.startBroadcast();
        safe = _deploy(owners_, threshold_, uint64(delay_));
        VM.stopBroadcast();
    }

    function _deploy(address[] memory owners_, uint256 threshold_, uint64 delay_)
        internal
        returns (ArtFiAdminSafe safe)
    {
        safe = new ArtFiAdminSafe(owners_, threshold_, delay_);
        AdminSafeDeploymentPolicy.validate(address(safe), address(safe).codehash);
    }
}
