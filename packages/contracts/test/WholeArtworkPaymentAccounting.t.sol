// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {WholeArtworkMarket} from "../src/WholeArtworkMarket.sol";

interface ArtworkAccountingVm {
    function addr(uint256 key) external pure returns (address);
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

/// @dev TEST_ONLY transfer behaviors; no external token, chain or wallet is used.
contract ArtworkAccountingPayment is ERC20 {
    uint8 public mode;

    constructor() ERC20("Accounting fixture", "ACCT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setMode(uint8 next) external {
        mode = next;
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0) || mode == 0) {
            super._update(from, to, amount);
            return;
        }
        if (mode == 1) super._update(from, address(0), 1);
        if (mode == 2) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
            return;
        }
        super._update(from, to, amount);
        if (mode == 3) super._update(address(0), to, 1);
        if (mode == 4) super._update(to, address(0), amount + 1);
        if (mode == 5) super._update(address(0), from, 1);
    }
}

contract ArtworkAccountingNFT is ERC721 {
    error TestTransferRejected();
    bool public rejectTransfer;
    constructor() ERC721("Test artwork", "TART") {}

    function mint(address to) external {
        _mint(to, 1);
    }

    function setReject(bool next) external {
        rejectTransfer = next;
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        if (_ownerOf(tokenId) != address(0) && rejectTransfer) {
            revert TestTransferRejected();
        }
        return super._update(to, tokenId, auth);
    }
}

contract WholeArtworkPaymentAccountingTest {
    ArtworkAccountingVm private constant VM =
        ArtworkAccountingVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant TEST_SELLER_KEY = 0xA11CE;
    address private constant BUYER = address(0xB0B);
    WholeArtworkMarket private market;
    ArtworkAccountingPayment private payment;
    ArtworkAccountingNFT private artwork;
    address private seller;

    function setUp() public {
        VM.warp(1000);
        seller = VM.addr(TEST_SELLER_KEY);
        market = new WholeArtworkMarket(address(this), address(this), address(this));
        payment = new ArtworkAccountingPayment();
        artwork = new ArtworkAccountingNFT();
        market.setCollectionAllowed(address(artwork), true);
        market.setPaymentTokenAllowed(address(payment), true);
        artwork.mint(seller);
        VM.prank(seller);
        artwork.setApprovalForAll(address(market), true);
        payment.mint(BUYER, 1e30);
        payment.mint(seller, 1000);
    }

    function testSenderSurchargeCannotExceedSignedPrice() public {
        _rejectPayment(1, 100);
    }

    function testSenderRebateCannotChangePaymentTerms() public {
        _rejectPayment(5, 100);
    }

    function testRecipientFeeCannotShortSeller() public {
        _rejectPayment(2, 100);
    }

    function testRecipientBonusCannotChangePaymentTerms() public {
        _rejectPayment(3, 100);
    }

    function testSellerBalanceDecreaseReturnsAmountMismatch() public {
        _rejectPayment(4, 100);
    }

    function testFuzzNonExactPaymentPreservesOwnerIntentAndAllowance(uint96 rawPrice, uint8 rawMode)
        public
    {
        _rejectPayment(rawMode % 5 + 1, uint256(rawPrice) % 1e18 + 2);
    }

    function testRejectedPaymentCanRetrySameSignedIntentOnce() public {
        _rejectPayment(1, 100);
        payment.setMode(0);
        WholeArtworkMarket.SaleIntent memory intent = _intent(100);
        bytes memory signature = _sign(intent);
        VM.prank(BUYER);
        market.fillIntent(intent, signature);
        require(artwork.ownerOf(1) == BUYER, "retry did not transfer artwork");
        require(market.intentUsed(market.intentHash(intent)), "retry did not consume intent");
        VM.prank(BUYER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.fillIntent, (intent, signature)));
        require(
            !ok && bytes4(reason) == WholeArtworkMarket.IntentAlreadyUsed.selector,
            "replay accepted"
        );
        require(
            payment.balanceOf(BUYER) == 1e30 - 100 && payment.balanceOf(seller) == 1100,
            "duplicate payment"
        );
    }

    function testExactPaymentMovesBothLegsWithoutRestingCustody() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent(1000);
        bytes memory signature = _sign(intent);
        VM.prank(BUYER);
        payment.approve(address(market), 1000);
        VM.prank(BUYER);
        market.fillIntent(intent, signature);
        require(payment.balanceOf(BUYER) == 1e30 - 1000, "buyer amount");
        require(payment.balanceOf(seller) == 2000, "seller amount");
        require(payment.allowance(BUYER, address(market)) == 0, "exact allowance");
        require(artwork.ownerOf(1) == BUYER, "owner not updated");
        require(
            artwork.balanceOf(address(market)) == 0 && payment.balanceOf(address(market)) == 0,
            "resting custody"
        );
    }

    function testRejectedArtworkTransferRollsBackExactPaymentAndIntent() public {
        WholeArtworkMarket.SaleIntent memory intent = _intent(100);
        bytes memory signature = _sign(intent);
        VM.prank(BUYER);
        payment.approve(address(market), 100);
        artwork.setReject(true);
        VM.prank(BUYER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.fillIntent, (intent, signature)));
        require(
            !ok && bytes4(reason) == ArtworkAccountingNFT.TestTransferRejected.selector,
            "wrong asset failure"
        );
        _assertUnchanged(intent);
    }

    function _rejectPayment(uint8 mode, uint256 price) private {
        WholeArtworkMarket.SaleIntent memory intent = _intent(price);
        bytes memory signature = _sign(intent);
        VM.prank(BUYER);
        payment.approve(address(market), price);
        payment.setMode(mode);
        VM.prank(BUYER);
        (bool ok, bytes memory reason) =
            address(market).call(abi.encodeCall(market.fillIntent, (intent, signature)));
        require(!ok, "non-exact payment accepted");
        require(
            reason.length >= 4
                && bytes4(reason) == WholeArtworkMarket.TransferAmountMismatch.selector,
            "wrong failure type"
        );
        _assertUnchanged(intent);
    }

    function _assertUnchanged(WholeArtworkMarket.SaleIntent memory intent) private view {
        require(
            payment.balanceOf(BUYER) == 1e30 && payment.balanceOf(seller) == 1000,
            "payment escaped rollback"
        );
        require(payment.allowance(BUYER, address(market)) == intent.price, "allowance consumed");
        require(artwork.ownerOf(1) == seller, "artwork escaped rollback");
        require(!market.intentUsed(market.intentHash(intent)), "failed fill consumed intent");
        require(
            payment.balanceOf(address(market)) == 0 && artwork.balanceOf(address(market)) == 0,
            "unexpected custody"
        );
    }

    function _intent(uint256 price) private view returns (WholeArtworkMarket.SaleIntent memory) {
        return WholeArtworkMarket.SaleIntent(
            seller, address(artwork), 1, address(payment), price, BUYER, 1, 1000, 2000, 0
        );
    }

    function _sign(WholeArtworkMarket.SaleIntent memory intent)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(TEST_SELLER_KEY, market.intentHash(intent));
        return abi.encodePacked(r, s, v);
    }
}
