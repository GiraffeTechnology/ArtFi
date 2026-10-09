// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {
    ERC721URIStorage
} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title ArtFi RWA NFT
/// @notice Source-authenticated ERC-721 representation for a fractional underlying asset.
/// @dev Source evidence, metadata validation and idempotency live in the sealed RWARegistry. This contract deliberately
///      has no upgrade or arbitrary metadata mutation path in Stage 2.
contract ArtFiRWA is ERC721URIStorage, AccessControl, Pausable {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    error ZeroAddress();
    error MintRegistryRequired();
    error MintRegistryAlreadyBound();
    address public immutable mintInitializer;
    address public mintRegistry;
    event MintRegistryBound(address indexed registry);

    uint256 private _nextTokenId = 1;

    constructor(
        string memory name_,
        string memory symbol_,
        address admin,
        address minter,
        address pauser
    ) ERC721(name_, symbol_) {
        if (admin == address(0) || minter == address(0) || pauser == address(0)) {
            revert ZeroAddress();
        }

        mintInitializer = admin;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        _grantRole(PAUSER_ROLE, pauser);
    }

    /// @notice Irreversibly seal issuance to the source-verifying registry during deployment.
    /// Subsequent administrator MINTER_ROLE grants cannot bypass this boundary.
    function bindMintRegistry(address registry) external {
        if (msg.sender != mintInitializer || registry.code.length == 0) {
            revert MintRegistryRequired();
        }
        if (mintRegistry != address(0)) revert MintRegistryAlreadyBound();
        (bool ok, bytes memory result) = registry.staticcall(abi.encodeWithSignature("nft()"));
        if (!ok || result.length != 32 || abi.decode(result, (address)) != address(this)) {
            revert MintRegistryRequired();
        }
        mintRegistry = registry;
        emit MintRegistryBound(registry);
    }

    function safeMint(address recipient, string calldata metadataURI)
        external
        onlyRole(MINTER_ROLE)
        whenNotPaused
        returns (uint256 tokenId)
    {
        if (mintRegistry == address(0) || msg.sender != mintRegistry) {
            revert MintRegistryRequired();
        }
        if (recipient == address(0)) revert ZeroAddress();

        tokenId = _nextTokenId++;
        _safeMint(recipient, tokenId);
        _setTokenURI(tokenId, metadataURI);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    /// @dev Deliberately not `whenNotPaused`, unlike `safeMint`. The pause stops new issuance;
    ///      it must never freeze a token an owner already holds, including the transfer that
    ///      returns a deposited NFT. `PRD.md` §4.2 forbids an administrative action holding
    ///      authority over a user's asset, and `ACCEPTANCE.md` §4.1 leaves no one to unpause.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
