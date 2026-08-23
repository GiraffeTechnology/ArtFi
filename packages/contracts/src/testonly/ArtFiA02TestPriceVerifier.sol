// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IArtFiBuyoutPriceVerifier} from "../ArtFiDAOActions.sol";

/// @title UNIT-A02 Base Sepolia test price verifier
/// @notice Accepts only the precommitted A02 test vault and evidence digest.
contract ArtFiA02TestPriceVerifier is IArtFiBuyoutPriceVerifier {
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;

    address public immutable expectedVault;
    bytes32 public immutable expectedEvidenceHash;

    error BaseSepoliaOnly(uint256 chainId);
    error InvalidConfiguration();

    constructor(address expectedVault_, bytes32 expectedEvidenceHash_) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert BaseSepoliaOnly(block.chainid);
        if (expectedVault_ == address(0) || expectedEvidenceHash_ == bytes32(0)) {
            revert InvalidConfiguration();
        }
        expectedVault = expectedVault_;
        expectedEvidenceHash = expectedEvidenceHash_;
    }

    function verifyBuyoutPrice(
        address vault,
        uint256 unitPriceWei,
        uint48,
        uint48,
        uint8,
        uint32,
        bytes32 evidenceHash
    ) external view returns (bool) {
        return vault == expectedVault && unitPriceWei != 0 && evidenceHash == expectedEvidenceHash;
    }
}
