// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {
    GovernorCountingSimple
} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {
    GovernorTimelockControl
} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {
    GovernorVotesQuorumFraction
} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ArtFiDAOActions} from "./ArtFiDAOActions.sol";
import {ArtFiVault} from "./ArtFiVault.sol";

/// @title ArtFi RWA Governor
/// @notice Snapshot-based token governance for exactly one NFT-backed ArtFi Vault.
contract ArtFiGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    enum ProposalKind {
        None,
        MarketMigration,
        PhysicalAction,
        ForcedBuyout
    }

    error InvalidProposalAction();
    error InvalidProposalKind();
    error InvalidRWA();
    error UnclassifiedProposalDisabled();

    event ProposalClassified(
        uint256 indexed proposalId, ProposalKind indexed kind, uint256 approvalNumerator
    );

    uint256 public constant APPROVAL_DENOMINATOR = 1_000_000;
    uint256 public constant MARKET_MIGRATION_APPROVAL = 500_000;
    uint256 public constant PHYSICAL_ACTION_APPROVAL = 666_667;
    uint256 public constant FORCED_BUYOUT_APPROVAL = 800_000;

    ArtFiVault public immutable rwaVault;
    ArtFiDAOActions public immutable actionRegistry;

    mapping(uint256 proposalId => ProposalKind kind) private _proposalKinds;

    constructor(
        ArtFiVault vault_,
        ArtFiDAOActions actionRegistry_,
        TimelockController timelock,
        uint48 votingDelayBlocks,
        uint32 votingPeriodBlocks,
        uint256 proposalThresholdTokens,
        uint256 quorumPercent
    )
        Governor("ArtFi RWA Governor")
        GovernorSettings(votingDelayBlocks, votingPeriodBlocks, proposalThresholdTokens)
        GovernorVotes(IVotes(address(vault_.fractionalToken())))
        GovernorVotesQuorumFraction(quorumPercent)
        GovernorTimelockControl(timelock)
    {
        if (
            address(vault_) == address(0) || address(actionRegistry_) == address(0)
                || address(actionRegistry_.rwaVault()) != address(vault_) || !_isRWAEligible(vault_)
        ) revert InvalidRWA();
        rwaVault = vault_;
        actionRegistry = actionRegistry_;
    }

    /// @notice Unclassified proposals are disabled so higher-threshold RWA actions cannot be mislabeled.
    function propose(address[] memory, uint256[] memory, bytes[] memory, string memory)
        public
        pure
        override
        returns (uint256)
    {
        revert UnclassifiedProposalDisabled();
    }

    function proposeWithKind(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        ProposalKind kind
    ) public returns (uint256 proposalId) {
        if (kind == ProposalKind.None) revert InvalidProposalKind();
        if (!_isRWAEligible(rwaVault)) revert InvalidRWA();
        _validateProposalAction(targets, values, calldatas, kind);

        proposalId = super.propose(targets, values, calldatas, description);
        _proposalKinds[proposalId] = kind;
        emit ProposalClassified(proposalId, kind, approvalNumerator(kind));
    }

    function proposalKind(uint256 proposalId) public view returns (ProposalKind) {
        return _proposalKinds[proposalId];
    }

    function approvalNumerator(ProposalKind kind) public pure returns (uint256) {
        if (kind == ProposalKind.MarketMigration) return MARKET_MIGRATION_APPROVAL;
        if (kind == ProposalKind.PhysicalAction) return PHYSICAL_ACTION_APPROVAL;
        if (kind == ProposalKind.ForcedBuyout) return FORCED_BUYOUT_APPROVAL;
        revert InvalidProposalKind();
    }

    function requiredForVotes(uint256 proposalId) public view returns (uint256) {
        ProposalKind kind = _proposalKinds[proposalId];
        uint256 totalSupply = token().getPastTotalSupply(proposalSnapshot(proposalId));
        return Math.mulDiv(totalSupply, approvalNumerator(kind), APPROVAL_DENOMINATOR);
    }

    function rwaEligible() external view returns (bool) {
        return _isRWAEligible(rwaVault);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    function _voteSucceeded(uint256 proposalId)
        internal
        view
        override(Governor, GovernorCountingSimple)
        returns (bool)
    {
        (, uint256 forVotes,) = proposalVotes(proposalId);
        return forVotes > requiredForVotes(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    function _validateProposalAction(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        ProposalKind kind
    ) private view {
        if (
            targets.length != 1 || values.length != 1 || calldatas.length != 1
                || targets[0] != address(actionRegistry) || values[0] != 0
                || calldatas[0].length < 4
        ) revert InvalidProposalAction();

        bytes4 selector;
        bytes memory callData = calldatas[0];
        assembly ("memory-safe") {
            selector := mload(add(callData, 0x20))
        }

        if (
            kind == ProposalKind.MarketMigration
                && selector == ArtFiDAOActions.recordMarketMigration.selector
        ) return;
        if (
            kind == ProposalKind.PhysicalAction
                && (selector == ArtFiDAOActions.requestPhysicalAction.selector
                    || selector == ArtFiDAOActions.recordSharedFailureAssessment.selector)
        ) return;
        if (
            kind == ProposalKind.ForcedBuyout
                && selector == ArtFiDAOActions.initiateForcedBuyout.selector
        ) return;
        revert InvalidProposalAction();
    }

    function _isRWAEligible(ArtFiVault vault_) private view returns (bool) {
        if (!vault_.deposited() || address(vault_.fractionalToken()) == address(0)) return false;
        IERC721 collection = vault_.collection();
        try collection.ownerOf(vault_.tokenId()) returns (address owner) {
            return owner == address(vault_);
        } catch {
            return false;
        }
    }
}
