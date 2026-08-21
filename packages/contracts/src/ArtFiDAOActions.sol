// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiVault} from "./ArtFiVault.sol";

interface IArtFiBuyoutPriceVerifier {
    function verifyBuyoutPrice(
        address vault,
        uint256 unitPriceWei,
        uint48 t0,
        uint48 observationStart,
        uint8 pricingRule,
        uint32 tradeCount,
        bytes32 evidenceHash
    ) external view returns (bool);
}

/// @title ArtFi DAO Actions
/// @notice Timelock-only RWA action ledger. Physical execution remains off-chain and evidence-gated.
contract ArtFiDAOActions {
    enum PhysicalAction {
        WarehouseTransfer,
        Auction,
        Sale,
        CustodianChange
    }

    enum BuyoutPricingRule {
        ThirtyDayVolumeWeightedAverage,
        LastTenActualTrades
    }

    struct ForcedBuyoutTerms {
        uint256 unitPriceWei;
        uint48 t0;
        uint48 observationStart;
        BuyoutPricingRule pricingRule;
        uint32 tradeCount;
        bytes32 evidenceHash;
        string evidenceURI;
    }

    error EvidenceRequired();
    error InvalidBuyoutTerms();
    error InvalidExecutor();
    error InvalidPriceEvidence();
    error UnauthorizedExecutor(address caller);

    event MarketMigrationRecorded(
        bytes32 indexed destinationMarketHash, bytes32 indexed evidenceHash, string evidenceURI
    );
    event PhysicalActionRequested(
        PhysicalAction indexed action, bytes32 indexed evidenceHash, string evidenceURI
    );
    event ForcedBuyoutInitiated(
        uint256 unitPriceWei,
        uint48 indexed t0,
        uint48 observationStart,
        BuyoutPricingRule pricingRule,
        uint32 tradeCount,
        bytes32 indexed evidenceHash,
        string evidenceURI
    );
    event SharedFailureAssessmentRecorded(
        uint256 totalCostWei,
        uint48 indexed dueDate,
        bytes32 indexed evidenceHash,
        string evidenceURI
    );

    uint48 public constant THIRTY_DAYS = 30 days;

    ArtFiVault public immutable rwaVault;
    address public immutable executor;
    IArtFiBuyoutPriceVerifier public immutable buyoutPriceVerifier;

    uint256 public actionNonce;
    bytes32 public lastEvidenceHash;
    bytes32 public destinationMarketHash;
    uint256 public forcedBuyoutUnitPriceWei;

    constructor(ArtFiVault vault_, address executor_, IArtFiBuyoutPriceVerifier verifier_) {
        if (
            address(vault_) == address(0) || executor_ == address(0)
                || address(verifier_) == address(0)
        ) {
            revert InvalidExecutor();
        }
        rwaVault = vault_;
        executor = executor_;
        buyoutPriceVerifier = verifier_;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert UnauthorizedExecutor(msg.sender);
        _;
    }

    function recordMarketMigration(
        bytes32 marketHash,
        bytes32 evidenceHash,
        string calldata evidenceURI
    ) external onlyExecutor {
        if (marketHash == bytes32(0)) revert EvidenceRequired();
        _requireEvidence(evidenceHash, evidenceURI);
        actionNonce += 1;
        lastEvidenceHash = evidenceHash;
        destinationMarketHash = marketHash;
        emit MarketMigrationRecorded(marketHash, evidenceHash, evidenceURI);
    }

    function requestPhysicalAction(
        PhysicalAction action,
        bytes32 evidenceHash,
        string calldata evidenceURI
    ) external onlyExecutor {
        _requireEvidence(evidenceHash, evidenceURI);
        actionNonce += 1;
        lastEvidenceHash = evidenceHash;
        emit PhysicalActionRequested(action, evidenceHash, evidenceURI);
    }

    /// @notice Records a shared failure-cost assessment. It never debits or closes a holder position.
    /// @dev Any future closeout module requires separately approved rules, legal review and a new audit.
    function recordSharedFailureAssessment(
        uint256 totalCostWei,
        uint48 dueDate,
        bytes32 evidenceHash,
        string calldata evidenceURI
    ) external onlyExecutor {
        if (totalCostWei == 0 || dueDate <= block.timestamp) {
            revert EvidenceRequired();
        }
        _requireEvidence(evidenceHash, evidenceURI);
        actionNonce += 1;
        lastEvidenceHash = evidenceHash;
        emit SharedFailureAssessmentRecorded(totalCostWei, dueDate, evidenceHash, evidenceURI);
    }

    function initiateForcedBuyout(ForcedBuyoutTerms calldata terms) external onlyExecutor {
        _requireEvidence(terms.evidenceHash, terms.evidenceURI);
        if (terms.unitPriceWei == 0 || terms.t0 > block.timestamp) revert InvalidBuyoutTerms();

        if (terms.pricingRule == BuyoutPricingRule.ThirtyDayVolumeWeightedAverage) {
            if (
                terms.tradeCount == 0 || terms.t0 < THIRTY_DAYS
                    || terms.observationStart != terms.t0 - THIRTY_DAYS
            ) revert InvalidBuyoutTerms();
        } else if (terms.tradeCount != 10 || terms.observationStart != 0) {
            revert InvalidBuyoutTerms();
        }

        bool valid = buyoutPriceVerifier.verifyBuyoutPrice(
            address(rwaVault),
            terms.unitPriceWei,
            terms.t0,
            terms.observationStart,
            uint8(terms.pricingRule),
            terms.tradeCount,
            terms.evidenceHash
        );
        if (!valid) revert InvalidPriceEvidence();

        actionNonce += 1;
        lastEvidenceHash = terms.evidenceHash;
        forcedBuyoutUnitPriceWei = terms.unitPriceWei;

        emit ForcedBuyoutInitiated(
            terms.unitPriceWei,
            terms.t0,
            terms.observationStart,
            terms.pricingRule,
            terms.tradeCount,
            terms.evidenceHash,
            terms.evidenceURI
        );
    }

    function _requireEvidence(bytes32 evidenceHash, string calldata evidenceURI) private pure {
        uint256 uriLength = bytes(evidenceURI).length;
        if (evidenceHash == bytes32(0) || uriLength == 0 || uriLength > 512) {
            revert EvidenceRequired();
        }
    }
}
