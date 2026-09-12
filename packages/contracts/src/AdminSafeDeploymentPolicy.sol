// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IArtFiAdminSafeConfiguration {
    function owners() external view returns (address[] memory);
    function threshold() external view returns (uint256);
    function delaySeconds() external view returns (uint64);
}

/// @notice Fail-closed validation shared by every privileged Hoodi deployment script.
library AdminSafeDeploymentPolicy {
    error AdminSafeCodehashMismatch(bytes32 expected, bytes32 actual);
    error DuplicateAdminSafeOwner(address owner);
    error InvalidAdminSafe(address candidate);
    error InvalidAdminSafeConfiguration(uint256 ownerCount, uint256 threshold, uint64 delaySeconds);

    function validate(address candidate, bytes32 expectedCodehash)
        internal
        view
        returns (address[] memory owners_, uint256 threshold_, uint64 delaySeconds_)
    {
        if (candidate == address(0) || candidate.code.length == 0) {
            revert InvalidAdminSafe(candidate);
        }
        bytes32 actualCodehash = candidate.codehash;
        if (expectedCodehash == bytes32(0) || actualCodehash != expectedCodehash) {
            revert AdminSafeCodehashMismatch(expectedCodehash, actualCodehash);
        }

        try IArtFiAdminSafeConfiguration(candidate).owners() returns (
            address[] memory configuredOwners
        ) {
            owners_ = configuredOwners;
        } catch {
            revert InvalidAdminSafe(candidate);
        }
        try IArtFiAdminSafeConfiguration(candidate).threshold() returns (
            uint256 configuredThreshold
        ) {
            threshold_ = configuredThreshold;
        } catch {
            revert InvalidAdminSafe(candidate);
        }
        try IArtFiAdminSafeConfiguration(candidate).delaySeconds() returns (
            uint64 configuredDelay
        ) {
            delaySeconds_ = configuredDelay;
        } catch {
            revert InvalidAdminSafe(candidate);
        }

        if (
            owners_.length < 2 || threshold_ < 2 || threshold_ > owners_.length
                || delaySeconds_ == 0
        ) {
            revert InvalidAdminSafeConfiguration(owners_.length, threshold_, delaySeconds_);
        }
        for (uint256 index; index < owners_.length; ++index) {
            if (owners_[index] == address(0)) revert InvalidAdminSafe(candidate);
            for (uint256 other = index + 1; other < owners_.length; ++other) {
                if (owners_[index] == owners_[other]) {
                    revert DuplicateAdminSafeOwner(owners_[index]);
                }
            }
        }
    }
}
