// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ArtFi testnet market
/// @notice Escrowed fixed-price, auction, and capped offering settlement with pull-based refunds.
contract ArtFiMarket is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TOKEN_MANAGER_ROLE = keccak256("TOKEN_MANAGER_ROLE");
    /// @dev Legacy auction clients receive a deterministic 5-minute anti-sniping response period.
    uint48 public constant LEGACY_AUCTION_EXTENSION_WINDOW = 5 minutes;
    uint48 public constant LEGACY_AUCTION_EXTENSION_DURATION = 5 minutes;

    enum ListingKind {
        FixedPrice,
        Auction
    }

    enum State {
        None,
        Active,
        Settled,
        Cancelled
    }

    struct Listing {
        address seller;
        IERC20 assetToken;
        IERC20 paymentToken;
        uint256 amountRemaining;
        uint256 unitPrice;
        uint48 startsAt;
        uint48 endsAt;
        ListingKind kind;
        State state;
        address highestBidder;
        uint256 highestBid;
        uint256 reservePrice;
        uint256 minimumBidIncrement;
        uint48 extensionWindow;
        uint48 extensionDuration;
    }

    struct Offering {
        address seller;
        IERC20 assetToken;
        IERC20 paymentToken;
        uint256 tokenAmount;
        uint256 allocatedTokens;
        uint256 minRaise;
        uint256 hardCap;
        uint256 raised;
        uint48 startsAt;
        uint48 endsAt;
        State state;
        bool successful;
    }

    struct ListingParams {
        bytes32 requestId;
        IERC20 assetToken;
        IERC20 paymentToken;
        uint256 amount;
        uint256 unitPrice;
        uint48 startsAt;
        uint48 endsAt;
        ListingKind kind;
        uint256 reservePrice;
        uint256 minimumBidIncrement;
        uint48 extensionWindow;
        uint48 extensionDuration;
    }

    error ActiveBidExists();
    error AmountUnavailable();
    error AuctionEndOverflow();
    error IdempotencyConflict(bytes32 requestId);
    error InvalidConfiguration();
    error InvalidState();
    error NotAuthorized();
    error OfferingNotSuccessful();
    error OfferingSuccessful();
    error PilotCapExceeded();
    error TokenNotAllowed();
    error TransferAmountMismatch();
    error ZeroAddress();

    event ListingCreated(
        bytes32 indexed requestId, uint256 indexed listingId, address indexed seller
    );
    event FixedOrderFilled(
        uint256 indexed listingId, address indexed buyer, uint256 amount, uint256 payment
    );
    event BidPlaced(uint256 indexed listingId, address indexed bidder, uint256 amount);
    event AuctionExtended(uint256 indexed listingId, uint48 previousEnd, uint48 extendedEnd);
    event AuctionReserveNotMet(
        uint256 indexed listingId, address indexed highestBidder, uint256 highestBid
    );
    event ListingSettled(uint256 indexed listingId, address indexed buyer, uint256 payment);
    event ListingCancelled(uint256 indexed listingId);
    event OfferingCreated(
        bytes32 indexed requestId, uint256 indexed offeringId, address indexed seller
    );
    event Contribution(
        uint256 indexed offeringId, address indexed contributor, uint256 payment, uint256 allocation
    );
    event OfferingFinalized(uint256 indexed offeringId, bool successful, uint256 raised);
    event OfferingClaimed(uint256 indexed offeringId, address indexed account, uint256 amount);
    event OfferingRefunded(uint256 indexed offeringId, address indexed account, uint256 amount);
    event CreditWithdrawn(address indexed account, address indexed token, uint256 amount);
    event TokenPermissionUpdated(address indexed token, bool assetAllowed, bool paymentAllowed);
    event PilotCapUpdated(address indexed account, address indexed paymentToken, uint256 cap);

    mapping(address token => bool allowed) public allowedAssetToken;
    mapping(address token => bool allowed) public allowedPaymentToken;
    mapping(uint256 listingId => Listing) private _listings;
    mapping(uint256 offeringId => Offering) public offerings;
    mapping(uint256 offeringId => mapping(address account => uint256)) public contributions;
    mapping(uint256 offeringId => mapping(address account => uint256)) public allocations;
    mapping(address account => mapping(address token => uint256)) public credits;
    mapping(address account => mapping(address paymentToken => uint256)) public pilotPaymentCap;
    mapping(address account => mapping(address paymentToken => uint256)) public pilotPaymentUsed;

    mapping(bytes32 requestId => uint256 recordId) private _listingByRequest;
    mapping(bytes32 requestId => bytes32 intentHash) private _listingIntent;
    mapping(bytes32 requestId => uint256 recordId) private _offeringByRequest;
    mapping(bytes32 requestId => bytes32 intentHash) private _offeringIntent;
    uint256 private _nextListingId = 1;
    uint256 private _nextOfferingId = 1;

    constructor(address admin, address pauser, address tokenManager) {
        if (admin == address(0) || pauser == address(0) || tokenManager == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(TOKEN_MANAGER_ROLE, tokenManager);
    }

    /// @notice ABI-compatible getter for the original listing fields.
    /// @dev Auction-specific additions are exposed separately through auctionTerms so the
    ///      generated ABI encoder never needs to return the expanded storage struct.
    function listings(uint256 listingId)
        external
        view
        returns (
            address seller,
            IERC20 assetToken,
            IERC20 paymentToken,
            uint256 amountRemaining,
            uint256 unitPrice,
            uint48 startsAt,
            uint48 endsAt,
            ListingKind kind,
            State state,
            address highestBidder,
            uint256 highestBid
        )
    {
        Listing storage listing = _listings[listingId];
        return (
            listing.seller,
            listing.assetToken,
            listing.paymentToken,
            listing.amountRemaining,
            listing.unitPrice,
            listing.startsAt,
            listing.endsAt,
            listing.kind,
            listing.state,
            listing.highestBidder,
            listing.highestBid
        );
    }

    function setTokenPermission(address token, bool assetAllowed, bool paymentAllowed)
        external
        onlyRole(TOKEN_MANAGER_ROLE)
    {
        if (token == address(0)) revert ZeroAddress();
        allowedAssetToken[token] = assetAllowed;
        allowedPaymentToken[token] = paymentAllowed;
        emit TokenPermissionUpdated(token, assetAllowed, paymentAllowed);
    }

    function setPilotCap(address account, address paymentToken, uint256 cap)
        external
        onlyRole(TOKEN_MANAGER_ROLE)
    {
        if (account == address(0) || paymentToken == address(0)) revert ZeroAddress();
        pilotPaymentCap[account][paymentToken] = cap;
        emit PilotCapUpdated(account, paymentToken, cap);
    }

    function createListing(
        bytes32 requestId,
        IERC20 assetToken,
        IERC20 paymentToken,
        uint256 amount,
        uint256 unitPrice,
        uint48 startsAt,
        uint48 endsAt,
        ListingKind kind
    ) external whenNotPaused nonReentrant returns (uint256 listingId) {
        uint256 reservePrice = kind == ListingKind.Auction ? unitPrice : 0;
        uint256 minimumBidIncrement = kind == ListingKind.Auction ? 1 : 0;
        uint48 extensionWindow;
        uint48 extensionDuration;
        if (kind == ListingKind.Auction) {
            uint48 auctionDuration = endsAt > startsAt ? endsAt - startsAt : 0;
            extensionWindow = auctionDuration < LEGACY_AUCTION_EXTENSION_WINDOW
                ? auctionDuration
                : LEGACY_AUCTION_EXTENSION_WINDOW;
            extensionDuration = LEGACY_AUCTION_EXTENSION_DURATION;
        }
        return _createListing(
            ListingParams({
                requestId: requestId,
                assetToken: assetToken,
                paymentToken: paymentToken,
                amount: amount,
                unitPrice: unitPrice,
                startsAt: startsAt,
                endsAt: endsAt,
                kind: kind,
                reservePrice: reservePrice,
                minimumBidIncrement: minimumBidIncrement,
                extensionWindow: extensionWindow,
                extensionDuration: extensionDuration
            })
        );
    }

    /// @notice Creates an auction with explicit reserve, increment, and anti-sniping terms.
    /// @dev The legacy createListing auction path remains ABI-compatible with reserve=openingBid,
    ///      minimumBidIncrement=1, and a deterministic anti-sniping response period. Its window is
    ///      capped to the auction duration so historical short-duration listings remain valid.
    function createAuctionListing(
        bytes32 requestId,
        IERC20 assetToken,
        IERC20 paymentToken,
        uint256 amount,
        uint256 openingBid,
        uint48 startsAt,
        uint48 endsAt,
        uint256 reservePrice,
        uint256 minimumBidIncrement,
        uint48 extensionWindow,
        uint48 extensionDuration
    ) external whenNotPaused nonReentrant returns (uint256 listingId) {
        if (extensionWindow == 0 || extensionDuration == 0) {
            revert InvalidConfiguration();
        }
        return _createListing(
            ListingParams({
                requestId: requestId,
                assetToken: assetToken,
                paymentToken: paymentToken,
                amount: amount,
                unitPrice: openingBid,
                startsAt: startsAt,
                endsAt: endsAt,
                kind: ListingKind.Auction,
                reservePrice: reservePrice,
                minimumBidIncrement: minimumBidIncrement,
                extensionWindow: extensionWindow,
                extensionDuration: extensionDuration
            })
        );
    }

    function _createListing(ListingParams memory params) private returns (uint256 listingId) {
        if (
            params.requestId == bytes32(0) || params.amount == 0 || params.unitPrice == 0
                || params.startsAt >= params.endsAt || params.endsAt <= block.timestamp
        ) {
            revert InvalidConfiguration();
        }
        if (
            !allowedAssetToken[address(params.assetToken)]
                || !allowedPaymentToken[address(params.paymentToken)]
        ) {
            revert TokenNotAllowed();
        }
        if (params.kind == ListingKind.FixedPrice) {
            if (
                params.reservePrice != 0 || params.minimumBidIncrement != 0
                    || params.extensionWindow != 0 || params.extensionDuration != 0
            ) revert InvalidConfiguration();
        } else if (
            params.reservePrice < params.unitPrice || params.minimumBidIncrement == 0
                || (params.extensionWindow == 0) != (params.extensionDuration == 0)
                || params.extensionWindow > params.endsAt - params.startsAt
        ) {
            revert InvalidConfiguration();
        }
        bytes32 intentHash = keccak256(abi.encode(msg.sender, params));
        listingId = _listingByRequest[params.requestId];
        if (listingId != 0) {
            if (_listingIntent[params.requestId] != intentHash) {
                revert IdempotencyConflict(params.requestId);
            }
            return listingId;
        }
        listingId = _nextListingId++;
        _listingByRequest[params.requestId] = listingId;
        _listingIntent[params.requestId] = intentHash;
        _listings[listingId] = Listing({
            seller: msg.sender,
            assetToken: params.assetToken,
            paymentToken: params.paymentToken,
            amountRemaining: params.amount,
            unitPrice: params.unitPrice,
            startsAt: params.startsAt,
            endsAt: params.endsAt,
            kind: params.kind,
            state: State.Active,
            highestBidder: address(0),
            highestBid: 0,
            reservePrice: params.reservePrice,
            minimumBidIncrement: params.minimumBidIncrement,
            extensionWindow: params.extensionWindow,
            extensionDuration: params.extensionDuration
        });
        _pullExact(params.assetToken, msg.sender, params.amount);
        emit ListingCreated(params.requestId, listingId, msg.sender);
    }

    function auctionTerms(uint256 listingId)
        external
        view
        returns (
            uint256 reservePrice,
            uint256 minimumBidIncrement,
            uint48 endsAt,
            uint48 extensionWindow,
            uint48 extensionDuration
        )
    {
        Listing storage listing = _listings[listingId];
        if (listing.kind != ListingKind.Auction || listing.state == State.None) {
            revert InvalidState();
        }
        return (
            listing.reservePrice,
            listing.minimumBidIncrement,
            listing.endsAt,
            listing.extensionWindow,
            listing.extensionDuration
        );
    }

    function buyFixed(uint256 listingId, uint256 amount) external whenNotPaused nonReentrant {
        Listing storage listing = _listings[listingId];
        _requireLive(listing);
        if (
            listing.kind != ListingKind.FixedPrice || amount == 0
                || amount > listing.amountRemaining
        ) revert AmountUnavailable();
        uint256 payment = amount * listing.unitPrice;
        _consumePilotCap(msg.sender, address(listing.paymentToken), payment);
        _pullExact(listing.paymentToken, msg.sender, payment);
        listing.amountRemaining -= amount;
        credits[listing.seller][address(listing.paymentToken)] += payment;
        if (listing.amountRemaining == 0) listing.state = State.Settled;
        listing.assetToken.safeTransfer(msg.sender, amount);
        emit FixedOrderFilled(listingId, msg.sender, amount, payment);
    }

    function placeBid(uint256 listingId, uint256 bidAmount) external whenNotPaused nonReentrant {
        Listing storage listing = _listings[listingId];
        _requireLive(listing);
        uint256 requiredBid = listing.highestBidder == address(0)
            ? listing.unitPrice
            : listing.highestBid + listing.minimumBidIncrement;
        if (listing.kind != ListingKind.Auction || bidAmount < requiredBid) {
            revert InvalidConfiguration();
        }
        bool shouldExtend = listing.extensionWindow != 0
            && uint256(listing.endsAt) - block.timestamp <= listing.extensionWindow;
        uint48 extendedEnd;
        if (shouldExtend) {
            uint256 candidateEnd = uint256(listing.endsAt) + listing.extensionDuration;
            if (candidateEnd > type(uint48).max) revert AuctionEndOverflow();
            extendedEnd = uint48(candidateEnd);
        }
        _consumePilotCap(msg.sender, address(listing.paymentToken), bidAmount);
        _pullExact(listing.paymentToken, msg.sender, bidAmount);
        if (listing.highestBidder != address(0)) {
            credits[listing.highestBidder][address(listing.paymentToken)] += listing.highestBid;
        }
        listing.highestBidder = msg.sender;
        listing.highestBid = bidAmount;
        emit BidPlaced(listingId, msg.sender, bidAmount);
        if (shouldExtend) {
            uint48 previousEnd = listing.endsAt;
            listing.endsAt = extendedEnd;
            emit AuctionExtended(listingId, previousEnd, listing.endsAt);
        }
    }

    function settleAuction(uint256 listingId) external nonReentrant {
        Listing storage listing = _listings[listingId];
        if (
            listing.state != State.Active || listing.kind != ListingKind.Auction
                || block.timestamp < listing.endsAt
        ) {
            revert InvalidState();
        }
        listing.state = State.Settled;
        uint256 amount = listing.amountRemaining;
        listing.amountRemaining = 0;
        if (listing.highestBidder == address(0) || listing.highestBid < listing.reservePrice) {
            if (listing.highestBidder != address(0)) {
                credits[listing.highestBidder][address(listing.paymentToken)] += listing.highestBid;
                emit AuctionReserveNotMet(listingId, listing.highestBidder, listing.highestBid);
            }
            listing.assetToken.safeTransfer(listing.seller, amount);
            emit ListingSettled(listingId, address(0), 0);
            return;
        }
        credits[listing.seller][address(listing.paymentToken)] += listing.highestBid;
        listing.assetToken.safeTransfer(listing.highestBidder, amount);
        emit ListingSettled(listingId, listing.highestBidder, listing.highestBid);
    }

    /// Deliberately not `whenNotPaused`. `createListing` escrows the seller's asset in this
    /// contract, and for a fixed-price listing with no bidder this is the seller's only way
    /// out. Gating it on the pause would let an administrative action freeze a user's assets,
    /// which `PRD.md` §4.2 forbids. The pause stops new market activity — createListing,
    /// buyFixed, placeBid, contribute — while every exit stays open, as settleAuction,
    /// finalizeOffering, claimOffering, refundOffering and withdrawCredit already do.
    function cancelListing(uint256 listingId) external nonReentrant {
        Listing storage listing = _listings[listingId];
        if (listing.state != State.Active || listing.seller != msg.sender) revert NotAuthorized();
        if (listing.highestBidder != address(0)) revert ActiveBidExists();
        listing.state = State.Cancelled;
        uint256 amount = listing.amountRemaining;
        listing.amountRemaining = 0;
        listing.assetToken.safeTransfer(listing.seller, amount);
        emit ListingCancelled(listingId);
    }

    function createOffering(
        bytes32 requestId,
        IERC20 assetToken,
        IERC20 paymentToken,
        uint256 tokenAmount,
        uint256 minRaise,
        uint256 hardCap,
        uint48 startsAt,
        uint48 endsAt
    ) external whenNotPaused nonReentrant returns (uint256 offeringId) {
        if (
            requestId == bytes32(0) || tokenAmount == 0 || minRaise == 0 || minRaise > hardCap
                || startsAt >= endsAt || endsAt <= block.timestamp
        ) {
            revert InvalidConfiguration();
        }
        if (!allowedAssetToken[address(assetToken)] || !allowedPaymentToken[address(paymentToken)]) revert TokenNotAllowed();
        bytes32 intentHash = keccak256(
            abi.encode(
                msg.sender,
                assetToken,
                paymentToken,
                tokenAmount,
                minRaise,
                hardCap,
                startsAt,
                endsAt
            )
        );
        offeringId = _offeringByRequest[requestId];
        if (offeringId != 0) {
            if (_offeringIntent[requestId] != intentHash) revert IdempotencyConflict(requestId);
            return offeringId;
        }
        offeringId = _nextOfferingId++;
        _offeringByRequest[requestId] = offeringId;
        _offeringIntent[requestId] = intentHash;
        offerings[offeringId] = Offering(
            msg.sender,
            assetToken,
            paymentToken,
            tokenAmount,
            0,
            minRaise,
            hardCap,
            0,
            startsAt,
            endsAt,
            State.Active,
            false
        );
        _pullExact(assetToken, msg.sender, tokenAmount);
        emit OfferingCreated(requestId, offeringId, msg.sender);
    }

    function contribute(uint256 offeringId, uint256 payment) external whenNotPaused nonReentrant {
        Offering storage offering = offerings[offeringId];
        if (
            offering.state != State.Active || block.timestamp < offering.startsAt
                || block.timestamp >= offering.endsAt || payment == 0
                || offering.raised + payment > offering.hardCap
        ) {
            revert InvalidState();
        }
        uint256 allocation = payment * offering.tokenAmount / offering.hardCap;
        if (allocation == 0) revert InvalidConfiguration();
        _consumePilotCap(msg.sender, address(offering.paymentToken), payment);
        _pullExact(offering.paymentToken, msg.sender, payment);
        offering.raised += payment;
        offering.allocatedTokens += allocation;
        contributions[offeringId][msg.sender] += payment;
        allocations[offeringId][msg.sender] += allocation;
        emit Contribution(offeringId, msg.sender, payment, allocation);
    }

    function finalizeOffering(uint256 offeringId) external nonReentrant {
        Offering storage offering = offerings[offeringId];
        if (offering.state != State.Active || block.timestamp < offering.endsAt) {
            revert InvalidState();
        }
        offering.state = State.Settled;
        offering.successful = offering.raised >= offering.minRaise;
        if (offering.successful) {
            credits[offering.seller][address(offering.paymentToken)] += offering.raised;
            uint256 unsold = offering.tokenAmount - offering.allocatedTokens;
            if (unsold != 0) offering.assetToken.safeTransfer(offering.seller, unsold);
        } else {
            offering.assetToken.safeTransfer(offering.seller, offering.tokenAmount);
        }
        emit OfferingFinalized(offeringId, offering.successful, offering.raised);
    }

    function claimOffering(uint256 offeringId) external nonReentrant {
        Offering storage offering = offerings[offeringId];
        if (offering.state != State.Settled || !offering.successful) {
            revert OfferingNotSuccessful();
        }
        uint256 amount = allocations[offeringId][msg.sender];
        if (amount == 0) revert AmountUnavailable();
        allocations[offeringId][msg.sender] = 0;
        offering.assetToken.safeTransfer(msg.sender, amount);
        emit OfferingClaimed(offeringId, msg.sender, amount);
    }

    function refundOffering(uint256 offeringId) external nonReentrant {
        Offering storage offering = offerings[offeringId];
        if (offering.state != State.Settled || offering.successful) revert OfferingSuccessful();
        uint256 amount = contributions[offeringId][msg.sender];
        if (amount == 0) revert AmountUnavailable();
        contributions[offeringId][msg.sender] = 0;
        offering.paymentToken.safeTransfer(msg.sender, amount);
        emit OfferingRefunded(offeringId, msg.sender, amount);
    }

    function withdrawCredit(IERC20 token) external nonReentrant {
        uint256 amount = credits[msg.sender][address(token)];
        if (amount == 0) revert AmountUnavailable();
        credits[msg.sender][address(token)] = 0;
        token.safeTransfer(msg.sender, amount);
        emit CreditWithdrawn(msg.sender, address(token), amount);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function _requireLive(Listing storage listing) private view {
        if (
            listing.state != State.Active || block.timestamp < listing.startsAt
                || block.timestamp >= listing.endsAt
        ) revert InvalidState();
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) {
            revert TransferAmountMismatch();
        }
    }

    function _consumePilotCap(address account, address paymentToken, uint256 amount) private {
        uint256 nextUsed = pilotPaymentUsed[account][paymentToken] + amount;
        if (nextUsed > pilotPaymentCap[account][paymentToken]) revert PilotCapExceeded();
        pilotPaymentUsed[account][paymentToken] = nextUsed;
    }
}
