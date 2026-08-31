// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title ArtFi Fractional Token
/// @notice Fixed-supply ERC-20 representation of one NFT held by one ArtFi vault.
contract FractionalToken is ERC20, ERC20Permit, ERC20Votes, AccessControl, Pausable {
    using Checkpoints for Checkpoints.Trace208;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    error InvalidSupply();
    error FutureBalanceLookup(uint256 timepoint, uint48 currentClock);
    error ZeroAddress();

    mapping(address account => Checkpoints.Trace208 checkpoints) private _balanceCheckpoints;

    constructor(
        string memory name_,
        string memory symbol_,
        address recipient,
        uint256 supply,
        address admin,
        address pauser
    ) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (recipient == address(0) || admin == address(0) || pauser == address(0)) {
            revert ZeroAddress();
        }
        if (supply == 0) revert InvalidSupply();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _mint(recipient, supply);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Returns the holder's ERC-20 balance at a completed clock timepoint.
    /// @dev This is deliberately independent from delegated ERC20Votes voting power.
    function getPastBalance(address account, uint256 timepoint) external view returns (uint256) {
        uint48 currentClock = clock();
        if (timepoint >= currentClock) revert FutureBalanceLookup(timepoint, currentClock);
        return _balanceCheckpoints[account].upperLookupRecent(SafeCast.toUint48(timepoint));
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
        whenNotPaused
    {
        super._update(from, to, value);
        uint48 timepoint = clock();
        if (from != address(0)) {
            _balanceCheckpoints[from].push(timepoint, SafeCast.toUint208(balanceOf(from)));
        }
        if (to != address(0) && to != from) {
            _balanceCheckpoints[to].push(timepoint, SafeCast.toUint208(balanceOf(to)));
        }
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
