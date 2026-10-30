// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {WholeArtworkMarket} from "../src/WholeArtworkMarket.sol";

interface WholeArtworkVm {
    function addr(uint256 privateKey) external pure returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract ArtworkNFT is ERC721 {
    constructor() ERC721("Whole Artwork", "WART") {}

    function mint(address recipient, uint256 tokenId) external {
        _mint(recipient, tokenId);
    }
}

contract PaymentToken is ERC20 {
    constructor() ERC20("Test USD", "TUSD") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

/// @dev Takes a cut on every transfer, so the recipient receives less than the stated amount.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee USD", "FUSD") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || value == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 10;
        super._update(from, to, value - fee);
        super._update(from, address(0xFEE), fee);
    }
}

/// @dev Minimal contract wallet that authorizes by EIP-1271, standing in for an ERC-8415 wallet.
contract ContractWallet is IERC1271 {
    address private immutable OWNER;

    constructor(address owner_) {
        OWNER = owner_;
    }

    function approveCollection(ERC721 collection, address operator) external {
        collection.setApprovalForAll(operator, true);
    }

    function isValidSignature(bytes32 digest, bytes memory signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (error == ECDSA.RecoverError.NoError && recovered == OWNER) {
            return IERC1271.isValidSignature.selector;
        }
        return 0xffffffff;
    }
}

/// Covers the whole-artwork signature settlement required by `PRD.md` §4.2.2 and by the venue
/// boundary in `AGENTS.md` §1.1 invariant 6: never custody, never counterparty, and never a user's
/// asset moved without that user's signature for that fill.
contract WholeArtworkMarketTest {
    WholeArtworkVm private constant VM =
        WholeArtworkVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SELLER_KEY = 0xA11CE;
    uint256 private constant STRANGER_KEY = 0xBADBEEF;
    address private constant BUYER = address(0xB0B);
    address private constant OTHER_BUYER = address(0xCAFE);
    uint256 private constant TOKEN_ID = 1;
    uint256 private constant PRICE = 1_000;

    WholeArtworkMarket private market;
    ArtworkNFT private collection;
    PaymentToken private payment;
    address private seller;

    function setUp() public {
        seller = VM.addr(SELLER_KEY);
        market = new WholeArtworkMarket(address(this), address(this), address(this));
        collection = new ArtworkNFT();
        payment = new PaymentToken();
        market.setCollectionAllowed(address(collection), true);
        market.setPaymentTokenAllowed(address(payment), true);

        collection.mint(seller, TOKEN_ID);
        VM.prank(seller);
        collection.setApprovalForAll(address(market), true);

        payment.mint(BUYER, 10 * PRICE);
        VM.prank(BUYER);
        payment.approve(address(market), type(uint256).max);
        payment.mint(OTHER_BUYER, 10 * PRICE);
        VM.prank(OTHER_BUYER);
        payment.approve(address(market), type(uint256).max);
    }

    function _intent() private view returns (WholeArtworkMarket.SaleIntent memory) {
        return WholeArtworkMarket.SaleIntent({
            seller: seller,
            collection: address(collection),
            tokenId: TOKEN_ID,
            paymentToken: address(payment),
            price: PRICE,
            buyer: address(0),
            salt: 1,
            startsAt: uint48(block.timestamp),
            endsAt: uint48(block.timestamp + 1 days),
            epoch: 0
        });
    }

    function _sign(uint256 key, WholeArtworkMarket.SaleIntent memory intent)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(key, market.intentHash(intent));
        return abi.encodePacked(r, s, v);
    }

    function _fill(
        address buyer,
        WholeArtworkMarket.SaleIntent memory intent,
        bytes memory signature
    ) private returns (bool ok) {
        VM.prank(buyer);
        (ok,) = address(market).call(abi.encodeCall(market.fillIntent, (intent, signature)));
    }

    /// The digest is rebuilt here from the EIP-712 primitives rather than read back from the
    /// contract, so `intentHash` is checked against the standard and not against itself. The web
    /// client signs this same digest.
    function testIntentHashIsTheEip712Digest() public view {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes32 structHash = keccak256(
            abi.encode(
                market.SALE_INTENT_TYPEHASH(),
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
        bytes32 expected =
            keccak256(abi.encodePacked(hex"1901", market.domainSeparator(), structHash));
        require(market.intentHash(intent) == expected, "digest is not the EIP-712 digest");
    }

    /// Locks the wire format against the browser signer. The same fixed intent, domain and digest
    /// appear in `apps/web/src/lib/whole-artwork-intent.test.ts`, computed there by an independent
    /// EIP-712 implementation. Either side drifting -- a renamed field, a reordered struct, a
    /// changed domain string -- fails here instead of producing signatures the market rejects.
    function testDigestMatchesTheBrowserSigner() public view {
        bytes32 domainTypeHash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 fixedDomainSeparator = keccak256(
            abi.encode(
                domainTypeHash,
                keccak256(bytes("ArtFi Whole Artwork Market")),
                keccak256(bytes("1")),
                uint256(560_048),
                address(0x00000000000000000000000000000000000000A1)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                market.SALE_INTENT_TYPEHASH(),
                address(0x000000000000000000000000000000000000bEEF),
                address(0x00000000000000000000000000000000000000C0),
                uint256(7),
                address(0x00000000000000000000000000000000000000d0),
                uint256(1_234_567_890),
                address(0),
                uint256(42),
                uint48(1000),
                uint48(2000),
                uint256(3)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", fixedDomainSeparator, structHash));
        require(
            digest == 0x29a4beddf736f69c2e0f72fed58c67d79b4a671bfdcc7729cd081318f64340b7,
            "digest drifted from the browser signer"
        );
    }

    /// The core of §4.2.2: both legs move in the fill, and the contract is never on either side.
    function testFillMovesBothLegsAndTheContractHoldsNothing() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(collection.ownerOf(TOKEN_ID) == seller, "seller must hold before the fill");
        uint256 sellerBefore = payment.balanceOf(seller);

        require(_fill(BUYER, intent, signature), "fill failed");

        require(collection.ownerOf(TOKEN_ID) == BUYER, "buyer did not receive the artwork");
        require(payment.balanceOf(seller) == sellerBefore + PRICE, "seller was not paid in full");
        require(collection.balanceOf(address(market)) == 0, "market held the artwork");
        require(payment.balanceOf(address(market)) == 0, "market held the payment");
    }

    /// A listing is an authorization, not a transfer. Nothing goes on chain until the fill, so the
    /// holder keeps the artwork and the market has no entry point that takes it early.
    function testSigningAnIntentMovesNothing() public view {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        _sign(SELLER_KEY, intent);
        require(collection.ownerOf(TOKEN_ID) == seller, "signing moved the artwork");
        require(collection.balanceOf(address(market)) == 0, "market took custody on listing");
    }

    /// §4.2.2: "A seller may keep the same tokens listed in several places at once." Two live
    /// intents over one artwork are both valid; the first fill settles and the second then fails
    /// because the seller no longer holds it -- not because the contract locked it.
    function testOneArtworkMayCarryTwoLiveIntents() public {
        WholeArtworkMarket.SaleIntent memory first = _intent();
        WholeArtworkMarket.SaleIntent memory second = _intent();
        second.salt = 2;
        second.price = PRICE * 2;
        bytes memory firstSignature = _sign(SELLER_KEY, first);
        bytes memory secondSignature = _sign(SELLER_KEY, second);

        require(_fill(BUYER, first, firstSignature), "first fill failed");
        require(!_fill(OTHER_BUYER, second, secondSignature), "second fill settled after the sale");
        require(collection.ownerOf(TOKEN_ID) == BUYER, "artwork left the first buyer");
    }

    function testFilledIntentCannotBeReplayed() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);
        require(_fill(BUYER, intent, signature), "fill failed");

        // Return the artwork so the replay fails on the consumed intent, not on holdership.
        VM.prank(BUYER);
        collection.transferFrom(BUYER, seller, TOKEN_ID);
        require(!_fill(OTHER_BUYER, intent, signature), "a spent intent was replayed");
    }

    /// Revocation is on chain, so a counterparty holding a valid signature cannot fill.
    function testRevokedIntentCannotBeFilledByASignatureHolder() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        VM.prank(seller);
        market.revokeIntent(intent);

        require(!_fill(BUYER, intent, signature), "a revoked intent was filled");
        require(collection.ownerOf(TOKEN_ID) == seller, "revoked intent moved the artwork");
    }

    function testOnlyTheSellerMayRevoke() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        VM.prank(BUYER);
        (bool ok,) = address(market).call(abi.encodeCall(market.revokeIntent, (intent)));
        require(!ok, "a stranger revoked the seller's intent");
    }

    function testIncrementEpochInvalidatesEveryOutstandingIntent() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        VM.prank(seller);
        market.incrementEpoch();

        require(!_fill(BUYER, intent, signature), "an intent survived the epoch bump");
        require(market.sellerEpoch(seller) == 1, "epoch did not advance");
    }

    function testSignatureFromAnotherAccountIsRejected() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory forged = _sign(STRANGER_KEY, intent);
        require(!_fill(BUYER, intent, forged), "a forged signature settled a sale");
        require(collection.ownerOf(TOKEN_ID) == seller, "forged signature moved the artwork");
    }

    /// The signature authorizes stated terms and nothing else. Raising the price after signing
    /// changes the digest, so the old signature no longer verifies.
    function testAlteredTermsInvalidateTheSignature() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        WholeArtworkMarket.SaleIntent memory altered = intent;
        altered.price = PRICE / 2;
        require(!_fill(BUYER, altered, signature), "altered terms settled on the old signature");

        altered = intent;
        altered.tokenId = TOKEN_ID + 1;
        require(!_fill(BUYER, altered, signature), "another artwork settled on the signature");
    }

    function testFillWindowBoundsAreEnforced() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.startsAt = uint48(block.timestamp + 100);
        intent.endsAt = uint48(block.timestamp + 200);
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(!_fill(BUYER, intent, signature), "filled before the window opened");

        VM.warp(intent.endsAt);
        require(!_fill(BUYER, intent, signature), "filled at the exclusive upper bound");

        VM.warp(intent.startsAt);
        require(_fill(BUYER, intent, signature), "a fill inside the window was refused");
    }

    function testTargetedIntentRejectsEveryOtherBuyer() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.buyer = BUYER;
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(!_fill(OTHER_BUYER, intent, signature), "a targeted intent took another buyer");
        require(_fill(BUYER, intent, signature), "the named buyer was refused");
    }

    function testSellerMayNotFillTheirOwnIntent() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);
        payment.mint(seller, PRICE);
        VM.prank(seller);
        payment.approve(address(market), type(uint256).max);
        require(!_fill(seller, intent, signature), "the seller bought their own artwork");
    }

    /// The pause stops new fills. Because nothing is ever escrowed it can strand nothing, and the
    /// holder keeps full control of the artwork while it is in force.
    function testPauseStopsFillsButNeverHoldsTheArtwork() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        market.pause();
        require(!_fill(BUYER, intent, signature), "a fill settled while paused");

        // The seller can still do whatever they like with the artwork during the pause.
        VM.prank(seller);
        collection.transferFrom(seller, OTHER_BUYER, TOKEN_ID);
        require(collection.ownerOf(TOKEN_ID) == OTHER_BUYER, "the pause froze the holder");

        VM.prank(OTHER_BUYER);
        collection.transferFrom(OTHER_BUYER, seller, TOKEN_ID);
        market.unpause();
        require(_fill(BUYER, intent, signature), "unpausing did not restore settlement");
    }

    /// A seller must be able to withdraw an authorization while the market is paused; otherwise an
    /// administrative action keeps a live claim on their artwork.
    function testRevocationAndEpochBumpWorkWhilePaused() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);
        market.pause();

        VM.prank(seller);
        market.revokeIntent(intent);
        VM.prank(seller);
        market.incrementEpoch();

        market.unpause();
        require(!_fill(BUYER, intent, signature), "an intent revoked while paused was filled");
    }

    /// No role reaches a user's artwork. Both privileged setters only close the market; neither
    /// moves, freezes nor reassigns anything a holder owns.
    function testAdministrativeSettersCannotReachAHoldersArtwork() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        market.setCollectionAllowed(address(collection), false);
        require(!_fill(BUYER, intent, signature), "a delisted collection still settled");
        require(collection.ownerOf(TOKEN_ID) == seller, "delisting moved the artwork");

        market.setCollectionAllowed(address(collection), true);
        market.setPaymentTokenAllowed(address(payment), false);
        require(!_fill(BUYER, intent, signature), "a delisted payment token still settled");
        require(collection.ownerOf(TOKEN_ID) == seller, "delisting moved the artwork");
    }

    function testFeeOnTransferPaymentIsRejected() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        market.setPaymentTokenAllowed(address(feeToken), true);
        feeToken.mint(BUYER, 10 * PRICE);
        VM.prank(BUYER);
        feeToken.approve(address(market), type(uint256).max);

        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.paymentToken = address(feeToken);
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(!_fill(BUYER, intent, signature), "a fee token shorted the seller");
        require(collection.ownerOf(TOKEN_ID) == seller, "artwork moved on a shorted payment");
    }

    function testSellerWhoNoLongerHoldsTheArtworkCannotSettle() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        VM.prank(seller);
        collection.transferFrom(seller, OTHER_BUYER, TOKEN_ID);

        require(!_fill(BUYER, intent, signature), "a non-holder sold the artwork");
        require(collection.ownerOf(TOKEN_ID) == OTHER_BUYER, "the holder lost the artwork");
    }

    /// A contract wallet authorizes on the same path as an EOA, so an ERC-8415 wallet can sell
    /// without a second settlement route existing for it.
    function testContractWalletSellsByEip1271Signature() public {
        ContractWallet wallet = new ContractWallet(VM.addr(SELLER_KEY));
        uint256 walletToken = 2;
        collection.mint(address(wallet), walletToken);
        wallet.approveCollection(collection, address(market));

        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.seller = address(wallet);
        intent.tokenId = walletToken;
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(_fill(BUYER, intent, signature), "the contract wallet could not sell");
        require(collection.ownerOf(walletToken) == BUYER, "buyer did not receive the artwork");
        require(payment.balanceOf(address(wallet)) == PRICE, "the wallet was not paid");
    }

    function testUnallowedCollectionAndPaymentTokenFailClosed() public {
        ArtworkNFT stranger = new ArtworkNFT();
        stranger.mint(seller, TOKEN_ID);
        VM.prank(seller);
        stranger.setApprovalForAll(address(market), true);

        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.collection = address(stranger);
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent)), "an unlisted collection settled");

        PaymentToken strangerToken = new PaymentToken();
        strangerToken.mint(BUYER, 10 * PRICE);
        VM.prank(BUYER);
        strangerToken.approve(address(market), type(uint256).max);
        intent = _intent();
        intent.paymentToken = address(strangerToken);
        require(
            !_fill(BUYER, intent, _sign(SELLER_KEY, intent)), "an unlisted payment token settled"
        );
    }

    function testZeroPriceAndInvertedWindowAreRejected() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.price = 0;
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent)), "a zero-price sale settled");

        intent = _intent();
        intent.endsAt = intent.startsAt;
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent)), "an empty window settled");
    }

    /// Whatever the terms, a settled sale leaves nothing behind in the contract.
    function testFuzzSettlementNeverLeavesValueInTheContract(uint96 price, uint32 window) public {
        if (price == 0 || window == 0) return;
        payment.mint(BUYER, price);
        VM.prank(BUYER);
        payment.approve(address(market), type(uint256).max);

        WholeArtworkMarket.SaleIntent memory intent = _intent();
        intent.price = price;
        intent.endsAt = uint48(block.timestamp + window);
        bytes memory signature = _sign(SELLER_KEY, intent);

        uint256 sellerBefore = payment.balanceOf(seller);
        require(_fill(BUYER, intent, signature), "fill failed");
        require(payment.balanceOf(seller) == sellerBefore + price, "seller was not paid in full");
        require(payment.balanceOf(address(market)) == 0, "market retained payment");
        require(collection.balanceOf(address(market)) == 0, "market retained the artwork");
    }
}
