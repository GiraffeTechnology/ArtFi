// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ArtFi UNIT-A02 isolated Base Sepolia test asset
/// @notice Mints exactly 100 test-only ERC-1155 units once for the A02 RWA/DAO exercise.
/// @dev This contract is deliberately impossible to deploy on any chain other than Base Sepolia.
///      It is not part of the charity-edition release set and conveys no production authorization.
contract ArtFiA02TestAsset is ERC1155Supply, AccessControl, Pausable {
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    uint256 public constant TOKEN_ID = 1;
    uint256 public constant FIXED_TEST_SUPPLY = 100;
    bytes32 public constant ARTWORK_ID = keccak256("UNIT-A02");
    bytes32 public constant TEST_NAMESPACE = keccak256("ARTFI/BASE-SEPOLIA/A02/RWA-DAO/V1");

    bytes32 public immutable metadataSha256;
    bytes32 public immutable physicalMappingEvidenceSha256;
    address public immutable initialDistributionWallet;
    string private _metadataURI;

    error BaseSepoliaOnly(uint256 chainId);
    error InvalidEvidenceHash();
    error InvalidMetadataURI();
    error ZeroAddress();

    constructor(
        address distributionWallet,
        address admin,
        address pauser,
        bytes32 metadataSha256_,
        bytes32 physicalMappingEvidenceSha256_,
        string memory metadataURI_
    ) ERC1155("") {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) {
            revert BaseSepoliaOnly(block.chainid);
        }
        if (distributionWallet == address(0) || admin == address(0) || pauser == address(0)) {
            revert ZeroAddress();
        }
        if (metadataSha256_ == bytes32(0) || physicalMappingEvidenceSha256_ == bytes32(0)) {
            revert InvalidEvidenceHash();
        }
        if (!_validURI(metadataURI_)) revert InvalidMetadataURI();

        metadataSha256 = metadataSha256_;
        physicalMappingEvidenceSha256 = physicalMappingEvidenceSha256_;
        initialDistributionWallet = distributionWallet;
        _metadataURI = metadataURI_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _mint(distributionWallet, TOKEN_ID, FIXED_TEST_SUPPLY, "");
        emit URI(metadataURI_, TOKEN_ID);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        if (tokenId != TOKEN_ID || !exists(tokenId)) return "";
        return _metadataURI;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override
        whenNotPaused
    {
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _validURI(string memory metadataURI_) private pure returns (bool) {
        bytes memory value = bytes(metadataURI_);
        if (value.length == 0 || value.length > 512) return false;
        return _startsWith(value, bytes("ipfs://")) || _startsWith(value, bytes("https://"));
    }

    function _startsWith(bytes memory value, bytes memory prefix) private pure returns (bool) {
        if (value.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (value[i] != prefix[i]) return false;
        }
        return true;
    }
}
