// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArtFi m-of-n administration safe
/// @notice Executes privileged calls only after an immutable owner threshold and timelock.
/// @dev Owners, threshold, and delay are immutable by design. A replacement requires an
///      independently reviewed deployment and explicit role handoff by this safe.
contract ArtFiAdminSafe is ReentrancyGuard {
    struct Transaction {
        bytes32 requestId;
        address target;
        uint256 value;
        bytes data;
        uint64 readyAt;
        uint32 confirmations;
        bool executed;
    }

    error AlreadyConfirmed(uint256 transactionId, address owner);
    error AlreadyExecuted(uint256 transactionId);
    error CallFailed(bytes32 returndataHash);
    error DuplicateOwner(address owner);
    error IdempotencyConflict(bytes32 requestId);
    error InvalidConfiguration();
    error NotConfirmed(uint256 transactionId, address owner);
    error NotOwner(address account);
    error ThresholdNotMet(uint256 transactionId, uint256 confirmations, uint256 threshold);
    error TimelockNotReady(uint256 transactionId, uint256 readyAt, uint256 currentTime);
    error TimelockOverflow();
    error UnknownTransaction(uint256 transactionId);
    error ZeroAddress();

    event TransactionSubmitted(
        uint256 indexed transactionId,
        bytes32 indexed requestId,
        address indexed proposer,
        address target,
        uint256 value,
        bytes32 dataHash
    );
    event TransactionConfirmed(
        uint256 indexed transactionId, address indexed owner, uint256 confirmations, uint64 readyAt
    );
    event ConfirmationRevoked(
        uint256 indexed transactionId, address indexed owner, uint256 confirmations
    );
    event TransactionExecuted(
        uint256 indexed transactionId, address indexed executor, bytes32 returndataHash
    );

    mapping(address owner => bool allowed) public isOwner;
    address[] private _owners;
    uint256 public immutable threshold;
    uint64 public immutable delaySeconds;
    uint256 public transactionCount;

    mapping(uint256 transactionId => Transaction transaction) private _transactions;
    mapping(uint256 transactionId => mapping(address owner => bool confirmed)) public confirmedBy;
    mapping(bytes32 requestId => uint256 transactionId) private _transactionByRequest;
    mapping(bytes32 requestId => bytes32 intentHash) private _requestIntent;

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner(msg.sender);
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_, uint64 delaySeconds_) {
        uint256 ownerCount = owners_.length;
        if (ownerCount < 2 || threshold_ < 2 || threshold_ > ownerCount || delaySeconds_ == 0) {
            revert InvalidConfiguration();
        }
        for (uint256 index; index < ownerCount; ++index) {
            address owner = owners_[index];
            if (owner == address(0)) revert ZeroAddress();
            if (isOwner[owner]) revert DuplicateOwner(owner);
            isOwner[owner] = true;
            _owners.push(owner);
        }
        threshold = threshold_;
        delaySeconds = delaySeconds_;
    }

    receive() external payable {}

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function transaction(uint256 transactionId) external view returns (Transaction memory) {
        Transaction storage stored = _requireTransaction(transactionId);
        return stored;
    }

    function submit(bytes32 requestId, address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (uint256 transactionId)
    {
        if (requestId == bytes32(0) || target == address(0)) revert InvalidConfiguration();
        bytes32 intentHash = keccak256(abi.encode(msg.sender, target, value, data));
        transactionId = _transactionByRequest[requestId];
        if (transactionId != 0) {
            if (_requestIntent[requestId] != intentHash) revert IdempotencyConflict(requestId);
            return transactionId;
        }

        transactionId = ++transactionCount;
        _transactionByRequest[requestId] = transactionId;
        _requestIntent[requestId] = intentHash;
        Transaction storage created = _transactions[transactionId];
        created.requestId = requestId;
        created.target = target;
        created.value = value;
        created.data = data;
        emit TransactionSubmitted(
            transactionId, requestId, msg.sender, target, value, keccak256(data)
        );
        _confirm(transactionId, created, msg.sender);
    }

    function confirm(uint256 transactionId) external onlyOwner {
        Transaction storage stored = _requireTransaction(transactionId);
        _confirm(transactionId, stored, msg.sender);
    }

    function revoke(uint256 transactionId) external onlyOwner {
        Transaction storage stored = _requireTransaction(transactionId);
        if (stored.executed) revert AlreadyExecuted(transactionId);
        if (!confirmedBy[transactionId][msg.sender]) {
            revert NotConfirmed(transactionId, msg.sender);
        }
        confirmedBy[transactionId][msg.sender] = false;
        --stored.confirmations;
        if (stored.confirmations < threshold) stored.readyAt = 0;
        emit ConfirmationRevoked(transactionId, msg.sender, stored.confirmations);
    }

    function execute(uint256 transactionId)
        external
        onlyOwner
        nonReentrant
        returns (bytes memory returndata)
    {
        Transaction storage stored = _requireTransaction(transactionId);
        if (stored.executed) revert AlreadyExecuted(transactionId);
        if (stored.confirmations < threshold) {
            revert ThresholdNotMet(transactionId, stored.confirmations, threshold);
        }
        if (stored.readyAt == 0 || block.timestamp < stored.readyAt) {
            revert TimelockNotReady(transactionId, stored.readyAt, block.timestamp);
        }

        stored.executed = true;
        (bool success, bytes memory result) = stored.target.call{value: stored.value}(stored.data);
        if (!success) revert CallFailed(keccak256(result));
        emit TransactionExecuted(transactionId, msg.sender, keccak256(result));
        return result;
    }

    function _confirm(uint256 transactionId, Transaction storage stored, address owner) private {
        if (stored.executed) revert AlreadyExecuted(transactionId);
        if (confirmedBy[transactionId][owner]) revert AlreadyConfirmed(transactionId, owner);
        confirmedBy[transactionId][owner] = true;
        ++stored.confirmations;
        if (stored.confirmations == threshold) {
            if (block.timestamp > type(uint64).max - delaySeconds) revert TimelockOverflow();
            stored.readyAt = uint64(block.timestamp) + delaySeconds;
        }
        emit TransactionConfirmed(transactionId, owner, stored.confirmations, stored.readyAt);
    }

    function _requireTransaction(uint256 transactionId)
        private
        view
        returns (Transaction storage stored)
    {
        stored = _transactions[transactionId];
        if (stored.target == address(0)) revert UnknownTransaction(transactionId);
    }
}
