// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {FractionalToken} from "./FractionalToken.sol";

/// @title ArtFi Vault
/// @notice Holds exactly one approved NFT and can issue exactly one fixed-supply fractional token.
contract ArtFiVault is AccessControl, IERC721Receiver, Pausable, ReentrancyGuard {
    bytes32 public constant FRACTIONALIZER_ROLE = keccak256("FRACTIONALIZER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public constant MAX_FRACTION_SUPPLY = 1_000_000_000_000 ether;

    error AlreadyDeposited();
    error AlreadyFractionalized();
    error InvalidFractionConfiguration();
    error InvalidNFT();
    error NotDeposited();
    error RecoveryAfterFractionalizationForbidden();
    error ZeroAddress();

    event NFTDeposited(address indexed collection, uint256 indexed tokenId, address indexed owner);
    event NFTEmergencyRecovered(address indexed recipient);
    event Fractionalized(address indexed token, address indexed recipient, uint256 supply);

    IERC721 public immutable collection;
    uint256 public immutable tokenId;
    address public immutable tokenAdmin;
    string public vaultName;

    address public originalOwner;
    FractionalToken public fractionalToken;
    uint256 public fractionalSupply;
    bool public deposited;

    constructor(
        string memory vaultName_,
        IERC721 collection_,
        uint256 tokenId_,
        address admin,
        address pauser,
        address fractionalizer
    ) {
        if (
            address(collection_) == address(0) || admin == address(0) || pauser == address(0)
                || fractionalizer == address(0)
        ) revert ZeroAddress();
        if (bytes(vaultName_).length < 2 || bytes(vaultName_).length > 80) {
            revert InvalidFractionConfiguration();
        }

        collection = collection_;
        tokenId = tokenId_;
        tokenAdmin = admin;
        vaultName = vaultName_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(FRACTIONALIZER_ROLE, fractionalizer);
    }

    function deposit() external whenNotPaused nonReentrant {
        if (deposited) revert AlreadyDeposited();
        collection.safeTransferFrom(msg.sender, address(this), tokenId);
        if (!deposited) revert InvalidNFT();
    }

    function fractionalize(
        string calldata name,
        string calldata symbol,
        uint256 supply,
        address recipient
    ) external onlyRole(FRACTIONALIZER_ROLE) whenNotPaused nonReentrant returns (address token) {
        if (!deposited) revert NotDeposited();
        if (address(fractionalToken) != address(0)) revert AlreadyFractionalized();
        if (
            recipient == address(0) || bytes(name).length < 2 || bytes(name).length > 80
                || bytes(symbol).length < 2 || bytes(symbol).length > 12 || supply < 1 ether
                || supply > MAX_FRACTION_SUPPLY
        ) revert InvalidFractionConfiguration();

        FractionalToken created = new FractionalToken(name, symbol, recipient, supply, tokenAdmin);
        fractionalToken = created;
        fractionalSupply = supply;
        token = address(created);
        emit Fractionalized(token, recipient, supply);
    }

    function emergencyRecover(address recipient)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenPaused
        nonReentrant
    {
        if (!deposited) revert NotDeposited();
        if (address(fractionalToken) != address(0)) {
            revert RecoveryAfterFractionalizationForbidden();
        }
        if (recipient == address(0)) revert ZeroAddress();

        deposited = false;
        collection.safeTransferFrom(address(this), recipient, tokenId);
        emit NFTEmergencyRecovered(recipient);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function onERC721Received(address, address from, uint256 receivedTokenId, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (msg.sender != address(collection) || receivedTokenId != tokenId) revert InvalidNFT();
        if (deposited) revert AlreadyDeposited();
        deposited = true;
        originalOwner = from;
        emit NFTDeposited(msg.sender, receivedTokenId, from);
        return IERC721Receiver.onERC721Received.selector;
    }
}
