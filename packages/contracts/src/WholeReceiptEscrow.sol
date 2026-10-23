// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {WholeArtworkMarket} from "./WholeArtworkMarket.sol";

/// @dev A deployment must supply a separately reviewed adapter to the EXISTING
/// authenticated Oracle/SettlementCoordinator evidence. This interface is not an
/// Oracle service, signer, registry, or authority to accept caller assertions.
/// The adapter must authenticate the source and bind the complete segment digest
/// (including participants, exact amount/token, request and execution reference)
/// to its canonical finalized historical certificate. A current holder/VALID
/// status/settlement ID alone MUST NOT satisfy this contract.
interface IWholeReceiptRegistrationVerifier {
    function verifyRegistration(bytes32 segmentDigest, bytes calldata evidence)
        external
        view
        returns (bytes32 authenticatedRecordHash);
}

/// @notice Isolated asynchronous settlement extension; NOT deployment-ready until
/// the canonical Oracle adapter and failure/recovery policies are accepted.
/// @dev The artwork passes directly seller -> buyer, never into this contract.
/// Only the consenting buyer's exact payment rests in a segment-specific escrow.
/// No administrator can withdraw, redirect, roll back, or burn an artwork.
/// There is deliberately no recovery/refund shortcut while NFT rollback and
/// registered-but-unpaid treatment remain unspecified. Never deploy with live
/// funds while these boundaries are incomplete.
contract WholeReceiptEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    WholeArtworkMarket public immutable marketPolicy;
    IWholeReceiptRegistrationVerifier public immutable registrationVerifier;
    bytes32 public immutable verifierCodeHash;

    bytes32 public constant SALE_INTENT_TYPEHASH = keccak256(
        "SaleIntent(address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch)"
    );
    bytes32 public constant RECEIPT_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiptAuthorization(bytes32 saleIntentHash,bytes32 settlementId,bytes32 assetRecordHash,bytes32 oracleSourceId,bytes32 requestHash,bytes32 executionReferenceHash,bytes32 previousSegment,bytes32 oldCertificateHash,bytes32 warehouseReceiptHash)"
    );

    struct Correspondence {
        bytes32 settlementId;
        bytes32 assetRecordHash;
        bytes32 oracleSourceId;
        bytes32 requestHash;
        bytes32 executionReferenceHash;
        bytes32 previousSegment;
        bytes32 oldCertificateHash;
        bytes32 warehouseReceiptHash;
    }

    struct Segment {
        address seller;
        address buyer;
        address paymentToken;
        uint256 amount;
        bytes32 registrationRecordHash;
        bytes32 registrationProofHash;
        bool paid;
    }

    mapping(bytes32 => Segment) private _segments;
    mapping(bytes32 => bool) public authorizationUsed;
    mapping(bytes32 => bytes32) public latestSegment;
    mapping(bytes32 => bytes32) public requestSegment;
    mapping(bytes32 => bytes32) public settlementSegment;
    mapping(bytes32 => bytes32) public executionSegment;
    mapping(address => uint256) public totalEscrowed;

    error InvalidConfiguration();
    error InvalidTerms();
    error InvalidAuthorization();
    error AuthorizationUnavailable();
    error TransferAmountMismatch();
    error ArtworkTransferMismatch();
    error UnknownSegment();
    error RegistrationUnavailable();
    error RegistrationConflict();
    error AlreadyPaid();

    event ReceiptFunded(
        bytes32 indexed segmentId,
        address indexed seller,
        address indexed buyer,
        address collection,
        uint256 tokenId,
        address paymentToken,
        uint256 amount,
        bytes32 settlementId,
        bytes32 requestHash,
        bytes32 executionReferenceHash,
        bytes32 previousSegment
    );
    event ReceiptRegistrationConfirmed(bytes32 indexed segmentId, bytes32 indexed recordHash);
    event ReceiptSellerPaid(bytes32 indexed segmentId, address indexed seller, address token, uint256 amount);
    event ReceiptAuthorizationRevoked(bytes32 indexed segmentId, address indexed seller);

    constructor(WholeArtworkMarket policy, IWholeReceiptRegistrationVerifier verifier, bytes32 expectedVerifierCodeHash)
        EIP712("ArtFi Whole Artwork Receipt Settlement", "1")
    {
        // No production deployment is enabled by this implementation checkpoint.
        if (block.chainid != 31337 && block.chainid != 560048) revert InvalidConfiguration();
        if (address(policy).code.length == 0 || address(verifier).code.length == 0 ||
            expectedVerifierCodeHash == bytes32(0) || address(verifier).codehash != expectedVerifierCodeHash) {
            revert InvalidConfiguration();
        }
        marketPolicy = policy;
        registrationVerifier = verifier;
        verifierCodeHash = expectedVerifierCodeHash;
    }

    function saleIntentStructHash(WholeArtworkMarket.SaleIntent calldata sale) public pure returns (bytes32) {
        return keccak256(abi.encode(SALE_INTENT_TYPEHASH, sale.seller, sale.collection, sale.tokenId,
            sale.paymentToken, sale.price, sale.buyer, sale.salt, sale.startsAt, sale.endsAt, sale.epoch));
    }

    /// @notice Reuses the existing sale terms, but not its atomic-fill signature.
    /// The distinct domain and full correspondence require explicit asynchronous
    /// seller consent. The named buyer authorizes its funding by calling fund.
    function authorizationHash(WholeArtworkMarket.SaleIntent calldata sale, Correspondence calldata correspondence)
        public view returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(RECEIPT_AUTHORIZATION_TYPEHASH,
            saleIntentStructHash(sale), correspondence.settlementId, correspondence.assetRecordHash,
            correspondence.oracleSourceId, correspondence.requestHash, correspondence.executionReferenceHash,
            correspondence.previousSegment, correspondence.oldCertificateHash, correspondence.warehouseReceiptHash)));
    }

    function assetKey(address collection, uint256 tokenId) public pure returns (bytes32) {
        return keccak256(abi.encode(collection, tokenId));
    }

    function segment(bytes32 id) external view returns (Segment memory) { return _segments[id]; }

    function fund(WholeArtworkMarket.SaleIntent calldata sale, Correspondence calldata correspondence, bytes calldata signature)
        external nonReentrant returns (bytes32 id)
    {
        _checkTerms(sale, correspondence);
        id = authorizationHash(sale, correspondence);
        if (authorizationUsed[id]) revert AuthorizationUnavailable();
        if (!SignatureChecker.isValidSignatureNow(sale.seller, id, signature)) revert InvalidAuthorization();
        if (IERC721(sale.collection).ownerOf(sale.tokenId) != sale.seller) revert InvalidTerms();

        authorizationUsed[id] = true;
        latestSegment[assetKey(sale.collection, sale.tokenId)] = id;
        requestSegment[correspondence.requestHash] = id;
        settlementSegment[correspondence.settlementId] = id;
        executionSegment[correspondence.executionReferenceHash] = id;
        _segments[id] = Segment(sale.seller, msg.sender, sale.paymentToken, sale.price, bytes32(0), bytes32(0), false);
        totalEscrowed[sale.paymentToken] += sale.price;

        _pullExact(sale.paymentToken, sale.price);
        IERC721(sale.collection).safeTransferFrom(sale.seller, msg.sender, sale.tokenId);
        // A receiving callback cannot immediately move the token away and cause
        // this journal event to claim a buyer that did not retain the artwork.
        if (IERC721(sale.collection).ownerOf(sale.tokenId) != msg.sender) revert ArtworkTransferMismatch();
        emit ReceiptFunded(id, sale.seller, msg.sender, sale.collection, sale.tokenId, sale.paymentToken,
            sale.price, correspondence.settlementId, correspondence.requestHash, correspondence.executionReferenceHash,
            correspondence.previousSegment);
    }

    function _pullExact(address token, uint256 amount) private {
        IERC20 payment = IERC20(token);
        uint256 custodyBefore = payment.balanceOf(address(this));
        uint256 buyerBefore = payment.balanceOf(msg.sender);
        payment.safeTransferFrom(msg.sender, address(this), amount);
        uint256 custodyAfter = payment.balanceOf(address(this));
        uint256 buyerAfter = payment.balanceOf(msg.sender);
        if (custodyAfter < custodyBefore || buyerAfter > buyerBefore ||
            custodyAfter - custodyBefore != amount || buyerBefore - buyerAfter != amount) revert TransferAmountMismatch();
    }

    function _checkTerms(WholeArtworkMarket.SaleIntent calldata sale, Correspondence calldata c) private view {
        if (marketPolicy.paused() || !marketPolicy.allowedCollection(sale.collection) ||
            !marketPolicy.allowedPaymentToken(sale.paymentToken) || sale.seller == address(0) ||
            sale.buyer != msg.sender || sale.seller == msg.sender || sale.buyer == address(this) ||
            sale.price == 0 || sale.startsAt >= sale.endsAt || block.timestamp < sale.startsAt ||
            block.timestamp >= sale.endsAt || sale.epoch != marketPolicy.sellerEpoch(sale.seller)) revert InvalidTerms();
        if (c.settlementId == bytes32(0) || c.assetRecordHash == bytes32(0) || c.oracleSourceId == bytes32(0) ||
            c.requestHash == bytes32(0) || c.executionReferenceHash == bytes32(0) ||
            c.oldCertificateHash == bytes32(0) || c.warehouseReceiptHash == bytes32(0) ||
            c.previousSegment != latestSegment[assetKey(sale.collection, sale.tokenId)] ||
            requestSegment[c.requestHash] != bytes32(0) || settlementSegment[c.settlementId] != bytes32(0) ||
            executionSegment[c.executionReferenceHash] != bytes32(0)) revert InvalidTerms();
        if (c.previousSegment != bytes32(0) && _segments[c.previousSegment].buyer != sale.seller) revert InvalidTerms();
    }

    /// @notice Records only an authenticated per-segment historical confirmation.
    /// It does not consult the latest holder or wait for later trades. Adapter
    /// failures leave funds and every already-confirmed/paid prefix unchanged.
    function confirmRegistration(bytes32 id, bytes calldata evidence) external nonReentrant {
        Segment storage current = _segments[id];
        if (current.buyer == address(0)) revert UnknownSegment();
        bytes32 proofHash = keccak256(evidence);
        if (current.registrationRecordHash != bytes32(0)) {
            if (current.registrationProofHash != proofHash) revert RegistrationConflict();
            return;
        }
        if (evidence.length == 0 || address(registrationVerifier).codehash != verifierCodeHash) revert RegistrationUnavailable();
        bytes32 record = registrationVerifier.verifyRegistration(id, evidence);
        if (record == bytes32(0)) revert RegistrationUnavailable();
        current.registrationRecordHash = record;
        current.registrationProofHash = proofHash;
        emit ReceiptRegistrationConfirmed(id, record);
    }

    /// @notice Anyone may relay the release, but its destination/amount cannot
    /// change. No global finality/current owner test can strand a confirmed prefix.
    function paySeller(bytes32 id) external nonReentrant {
        Segment storage current = _segments[id];
        if (current.buyer == address(0)) revert UnknownSegment();
        if (current.paid) revert AlreadyPaid();
        if (current.registrationRecordHash == bytes32(0)) revert RegistrationUnavailable();
        current.paid = true;
        totalEscrowed[current.paymentToken] -= current.amount;
        IERC20 payment = IERC20(current.paymentToken);
        uint256 custodyBefore = payment.balanceOf(address(this));
        uint256 sellerBefore = payment.balanceOf(current.seller);
        payment.safeTransfer(current.seller, current.amount);
        uint256 custodyAfter = payment.balanceOf(address(this));
        uint256 sellerAfter = payment.balanceOf(current.seller);
        if (custodyAfter > custodyBefore || sellerAfter < sellerBefore ||
            custodyBefore - custodyAfter != current.amount || sellerAfter - sellerBefore != current.amount) revert TransferAmountMismatch();
        emit ReceiptSellerPaid(id, current.seller, current.paymentToken, current.amount);
    }

    function revoke(WholeArtworkMarket.SaleIntent calldata sale, Correspondence calldata correspondence) external {
        if (msg.sender != sale.seller) revert InvalidAuthorization();
        bytes32 id = authorizationHash(sale, correspondence);
        if (authorizationUsed[id]) revert AuthorizationUnavailable();
        authorizationUsed[id] = true;
        emit ReceiptAuthorizationRevoked(id, msg.sender);
    }
}
