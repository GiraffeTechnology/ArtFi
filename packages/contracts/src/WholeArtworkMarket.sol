// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArtFi whole-artwork market
/// @notice Signature settlement for a whole artwork (ERC-721). The seller signs an EIP-712 sale
///         intent off chain; the artwork stays in the seller's wallet and moves only inside the
///         atomic fill that intent authorized.
/// @dev `PRD.md` §4.2.2 (client ruling 2026-08-30) requires the non-auction path to settle by
///      signature: no `_pullExact` at listing time, both sides pulled at fill time, and no resting
///      balance in the contract. `AGENTS.md` §1.1 invariant 6 states the same boundary as never
///      custody, never counterparty, and never a user's asset moved without that user's signature
///      for that fill.
///
///      Three properties therefore hold structurally and are covered by tests:
///      - **No asset at rest.** The contract never receives the artwork or the payment. It has no
///        balance to drain and no credit ledger to withdraw from.
///      - **No administrative reach.** No role can move, freeze or reassign a listed artwork. The
///        pause stops new fills only; it cannot strand anything, because nothing is ever held.
///      - **No seller privilege.** Entry is open to any address and no branch reads seller
///        identity, which `PRD.md` §4.2.1 requires of a self-operated and intermediary listing
///        alike.
///
///      This contract covers the whole artwork only. Fractions are ERC-20 and keep their own path
///      in `ArtFiMarket.sol`, including the auction escrow that §4.2.2 deliberately retains.
contract WholeArtworkMarket is AccessControl, EIP712, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TOKEN_MANAGER_ROLE = keccak256("TOKEN_MANAGER_ROLE");

    /// @notice An off-chain authorization to sell one artwork at stated terms.
    /// @param seller The holder authorizing the sale. The signature must verify against it.
    /// @param collection The ERC-721 contract holding the artwork.
    /// @param tokenId The artwork.
    /// @param paymentToken The ERC-20 the buyer pays in.
    /// @param price The exact amount the seller receives, in `paymentToken` units.
    /// @param buyer The only address allowed to fill, or the zero address for an open intent.
    /// @param salt Caller-chosen value making otherwise identical intents distinct.
    /// @param startsAt Inclusive lower bound of the fill window.
    /// @param endsAt Exclusive upper bound of the fill window.
    /// @param epoch The seller's epoch at signing time; `incrementEpoch` invalidates every intent
    ///        signed against an earlier one.
    struct SaleIntent {
        address seller;
        address collection;
        uint256 tokenId;
        address paymentToken;
        uint256 price;
        address buyer;
        uint256 salt;
        uint48 startsAt;
        uint48 endsAt;
        uint256 epoch;
    }

    /// @dev Field order fixes the EIP-712 type hash and must stay in step with the web client in
    ///      `apps/web/src/lib/whole-artwork-intent.ts`. `intentHash` is exposed so the two can be
    ///      compared directly rather than trusted to agree.
    bytes32 public constant SALE_INTENT_TYPEHASH = keccak256(
        "SaleIntent(address seller,address collection,uint256 tokenId,address paymentToken,uint256 price,address buyer,uint256 salt,uint48 startsAt,uint48 endsAt,uint256 epoch)"
    );

    error CollectionNotAllowed();
    error EpochMismatch();
    error IntentAlreadyUsed();
    error IntentExpired();
    error IntentNotYetOpen();
    error InvalidConfiguration();
    error InvalidSignature();
    error NotAuthorized();
    error NotTheBuyer();
    error PaymentTokenNotAllowed();
    error SellerIsNotTheHolder();
    error SellerMayNotBuy();
    error TransferAmountMismatch();
    error ZeroAddress();

    event SaleSettled(
        bytes32 indexed intentHash,
        address indexed seller,
        address indexed buyer,
        address collection,
        uint256 tokenId,
        address paymentToken,
        uint256 price
    );
    event SaleIntentRevoked(bytes32 indexed intentHash, address indexed seller);
    event SellerEpochIncremented(address indexed seller, uint256 epoch);
    event CollectionPermissionUpdated(address indexed collection, bool allowed);
    event PaymentTokenPermissionUpdated(address indexed paymentToken, bool allowed);

    mapping(address collection => bool allowed) public allowedCollection;
    mapping(address paymentToken => bool allowed) public allowedPaymentToken;
    /// @dev Set on fill and on revocation alike, so a revoked intent is unfillable on chain and a
    ///      counterparty holding the signature cannot use it.
    mapping(bytes32 intentHash => bool used) public intentUsed;
    mapping(address seller => uint256 epoch) public sellerEpoch;

    constructor(address admin, address pauser, address tokenManager)
        EIP712("ArtFi Whole Artwork Market", "1")
    {
        if (admin == address(0) || pauser == address(0) || tokenManager == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(TOKEN_MANAGER_ROLE, tokenManager);
    }

    /// @notice The EIP-712 digest a seller signs for `intent`.
    function intentHash(SaleIntent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(_structHash(intent));
    }

    /// @notice Domain separator, exposed so an off-chain signer can be checked against this
    ///         deployment rather than against a hardcoded chain id or address.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Settles `intent` in one transaction: payment from the caller to the seller, the
    ///         artwork from the seller to the caller.
    /// @dev The contract holds neither leg at any point. It is not a counterparty to the trade;
    ///      it verifies the seller's authorization and moves both sides atomically.
    function fillIntent(SaleIntent calldata intent, bytes calldata signature)
        external
        whenNotPaused
        nonReentrant
    {
        if (!allowedCollection[intent.collection]) revert CollectionNotAllowed();
        if (!allowedPaymentToken[intent.paymentToken]) revert PaymentTokenNotAllowed();
        if (intent.seller == address(0) || intent.price == 0 || intent.startsAt >= intent.endsAt) {
            revert InvalidConfiguration();
        }
        if (block.timestamp < intent.startsAt) revert IntentNotYetOpen();
        if (block.timestamp >= intent.endsAt) revert IntentExpired();
        if (intent.buyer != address(0) && intent.buyer != msg.sender) revert NotTheBuyer();
        if (intent.seller == msg.sender) revert SellerMayNotBuy();
        if (intent.epoch != sellerEpoch[intent.seller]) revert EpochMismatch();

        bytes32 digest = _hashTypedDataV4(_structHash(intent));
        if (intentUsed[digest]) revert IntentAlreadyUsed();

        // Accepts an EIP-1271 signature as well as a secp256k1 one, so a contract wallet -- an
        // ERC-8415 wallet among them -- can authorize a sale on the same path as an EOA.
        if (!SignatureChecker.isValidSignatureNow(intent.seller, digest, signature)) {
            revert InvalidSignature();
        }

        IERC721 collection = IERC721(intent.collection);
        if (collection.ownerOf(intent.tokenId) != intent.seller) revert SellerIsNotTheHolder();

        // Consume before either transfer: a token whose receive hook re-enters finds the intent
        // already spent.
        intentUsed[digest] = true;

        IERC20 paymentToken = IERC20(intent.paymentToken);
        uint256 sellerBalanceBefore = paymentToken.balanceOf(intent.seller);
        paymentToken.safeTransferFrom(msg.sender, intent.seller, intent.price);
        // A fee-on-transfer payment token would silently short the seller. Reject it rather than
        // settle a sale on terms the seller did not sign.
        if (paymentToken.balanceOf(intent.seller) - sellerBalanceBefore != intent.price) {
            revert TransferAmountMismatch();
        }

        collection.safeTransferFrom(intent.seller, msg.sender, intent.tokenId);

        emit SaleSettled(
            digest,
            intent.seller,
            msg.sender,
            intent.collection,
            intent.tokenId,
            intent.paymentToken,
            intent.price
        );
    }

    /// @notice Revokes one intent on chain, so holding the signature is no longer enough to fill.
    /// @dev Deliberately not `whenNotPaused`. Revocation removes an authorization the seller gave;
    ///      an administrative pause must never be able to keep one alive.
    function revokeIntent(SaleIntent calldata intent) external {
        if (intent.seller != msg.sender) revert NotAuthorized();
        bytes32 digest = _hashTypedDataV4(_structHash(intent));
        if (intentUsed[digest]) revert IntentAlreadyUsed();
        intentUsed[digest] = true;
        emit SaleIntentRevoked(digest, msg.sender);
    }

    /// @notice Invalidates every intent this seller signed against the current epoch.
    /// @dev Also not `whenNotPaused`, for the reason given on `revokeIntent`.
    function incrementEpoch() external {
        uint256 next = ++sellerEpoch[msg.sender];
        emit SellerEpochIncremented(msg.sender, next);
    }

    function setCollectionAllowed(address collection, bool allowed)
        external
        onlyRole(TOKEN_MANAGER_ROLE)
    {
        if (collection == address(0)) revert ZeroAddress();
        allowedCollection[collection] = allowed;
        emit CollectionPermissionUpdated(collection, allowed);
    }

    function setPaymentTokenAllowed(address paymentToken, bool allowed)
        external
        onlyRole(TOKEN_MANAGER_ROLE)
    {
        if (paymentToken == address(0)) revert ZeroAddress();
        allowedPaymentToken[paymentToken] = allowed;
        emit PaymentTokenPermissionUpdated(paymentToken, allowed);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _structHash(SaleIntent calldata intent) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                SALE_INTENT_TYPEHASH,
                intent.seller,
                intent.collection,
                intent.tokenId,
                intent.paymentToken,
                intent.price,
                intent.buyer,
                intent.salt,
                intent.startsAt,
                intent.endsAt,
                intent.epoch
            )
        );
    }
}
