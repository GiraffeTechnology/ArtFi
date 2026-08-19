// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {ArtFiVault} from "./ArtFiVault.sol";

/// @title ArtFi Vault Factory
/// @notice Creates one idempotent vault record for each NFT selected for fractionalization.
contract VaultFactory is AccessControl, Pausable {
    bytes32 public constant CREATOR_ROLE = keccak256("CREATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    error AssetAlreadyVaulted(address vault);
    error EmptyRequestId();
    error IdempotencyConflict(bytes32 requestId);
    error ZeroAddress();

    event VaultCreated(
        bytes32 indexed requestId,
        address indexed vault,
        address indexed collection,
        uint256 tokenId,
        string vaultName
    );

    mapping(bytes32 requestId => address vault) private _vaultByRequest;
    mapping(bytes32 requestId => bytes32 intentHash) private _intentByRequest;
    mapping(bytes32 assetKey => address vault) public vaultByAsset;

    constructor(address admin, address creator, address pauser) {
        if (admin == address(0) || creator == address(0) || pauser == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CREATOR_ROLE, creator);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function createVault(
        bytes32 requestId,
        string calldata vaultName,
        IERC721 collection,
        uint256 tokenId,
        address admin,
        address pauser,
        address fractionalizer
    ) external onlyRole(CREATOR_ROLE) whenNotPaused returns (address vault) {
        if (requestId == bytes32(0)) revert EmptyRequestId();
        if (
            address(collection) == address(0) || admin == address(0) || pauser == address(0)
                || fractionalizer == address(0)
        ) revert ZeroAddress();

        bytes32 intentHash =
            keccak256(abi.encode(vaultName, collection, tokenId, admin, pauser, fractionalizer));
        vault = _vaultByRequest[requestId];
        if (vault != address(0)) {
            if (_intentByRequest[requestId] != intentHash) revert IdempotencyConflict(requestId);
            return vault;
        }

        bytes32 assetKey = keccak256(abi.encode(collection, tokenId));
        if (vaultByAsset[assetKey] != address(0)) {
            revert AssetAlreadyVaulted(vaultByAsset[assetKey]);
        }

        vault =
            address(new ArtFiVault(vaultName, collection, tokenId, admin, pauser, fractionalizer));
        _vaultByRequest[requestId] = vault;
        _intentByRequest[requestId] = intentHash;
        vaultByAsset[assetKey] = vault;
        emit VaultCreated(requestId, vault, address(collection), tokenId, vaultName);
    }

    function vaultForRequest(bytes32 requestId) external view returns (address) {
        return _vaultByRequest[requestId];
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
