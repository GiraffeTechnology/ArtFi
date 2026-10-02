// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ArtFiMarket} from "../src/ArtFiMarket.sol";

interface FractionIntentVm {
    function addr(uint256 privateKey) external pure returns (address);
    function prank(address sender) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        pure
        returns (uint8 v, bytes32 r, bytes32 s);
    function warp(uint256 timestamp) external;
}

contract IntentToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

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

/// The fractions fixed-price path after `PRD.md` §4.2.2 (client ruling 2026-08-30): settled by
/// signature, nothing escrowed at listing time, no resting balance, and partial fills counted
/// cumulatively against the intent hash rather than burning the signature on first use (§4.2).
contract FractionSaleIntentTest {
    FractionIntentVm private constant VM =
        FractionIntentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant SELLER_KEY = 0xA11CE;
    uint256 private constant STRANGER_KEY = 0xBADBEEF;
    address private constant BUYER = address(0xB0B);
    address private constant OTHER_BUYER = address(0xCAFE);
    uint256 private constant MAX_AMOUNT = 100;
    uint256 private constant UNIT_PRICE = 3;

    ArtFiMarket private market;
    IntentToken private asset;
    IntentToken private payment;
    address private seller;

    function setUp() public {
        seller = VM.addr(SELLER_KEY);
        market = new ArtFiMarket(address(this), address(this), address(this));
        asset = new IntentToken("Fraction", "FRC");
        payment = new IntentToken("Test USD", "TUSD");
        market.setTokenPermission(address(asset), true, false);
        market.setTokenPermission(address(payment), false, true);
        market.setPilotCap(BUYER, address(payment), 1_000_000);
        market.setPilotCap(OTHER_BUYER, address(payment), 1_000_000);

        asset.mint(seller, 1_000);
        VM.prank(seller);
        asset.approve(address(market), type(uint256).max);

        payment.mint(BUYER, 1_000_000);
        VM.prank(BUYER);
        payment.approve(address(market), type(uint256).max);
        payment.mint(OTHER_BUYER, 1_000_000);
        VM.prank(OTHER_BUYER);
        payment.approve(address(market), type(uint256).max);
    }

    function _intent() private view returns (ArtFiMarket.SaleIntent memory) {
        return ArtFiMarket.SaleIntent({
            seller: seller,
            assetToken: address(asset),
            paymentToken: address(payment),
            maxAmount: MAX_AMOUNT,
            unitPrice: UNIT_PRICE,
            buyer: address(0),
            salt: 1,
            startsAt: uint48(block.timestamp),
            endsAt: uint48(block.timestamp + 1 days),
            epoch: 0
        });
    }

    function _sign(uint256 key, ArtFiMarket.SaleIntent memory intent)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(key, market.intentHash(intent));
        return abi.encodePacked(r, s, v);
    }

    function _fill(
        address buyer,
        ArtFiMarket.SaleIntent memory intent,
        bytes memory signature,
        uint256 amount
    ) private returns (bool ok) {
        VM.prank(buyer);
        (ok,) = address(market).call(abi.encodeCall(market.fillIntent, (intent, signature, amount)));
    }

    /// Rebuilt from the EIP-712 primitives rather than read back from the contract, so the digest
    /// is checked against the standard and not against itself.
    function testIntentHashIsTheEip712Digest() public view {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes32 structHash = keccak256(
            abi.encode(
                market.SALE_INTENT_TYPEHASH(),
                intent.seller,
                intent.assetToken,
                intent.paymentToken,
                intent.maxAmount,
                intent.unitPrice,
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

    /// The ruling's first stated consequence: the fixed-price path holds no assets at rest.
    function testFillPaysTheSellerDirectlyAndTheMarketHoldsNothing() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(asset.balanceOf(address(market)) == 0, "market held fractions before the fill");
        uint256 sellerPaymentBefore = payment.balanceOf(seller);

        require(_fill(BUYER, intent, signature, 40), "fill failed");

        require(asset.balanceOf(BUYER) == 40, "buyer did not receive the fractions");
        require(
            payment.balanceOf(seller) == sellerPaymentBefore + 40 * UNIT_PRICE,
            "seller was not paid in full"
        );
        // No credit ledger entry: the seller was paid, not credited.
        require(market.credits(seller, address(payment)) == 0, "a resting credit was created");
        require(asset.balanceOf(address(market)) == 0, "market retained fractions");
        require(payment.balanceOf(address(market)) == 0, "market retained payment");
    }

    /// §4.2: partial fills consume the intent cumulatively, so the signature is neither burned on
    /// first use nor reusable without limit.
    function testPartialFillsAccumulateAndStopAtTheAuthorizedMaximum() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(_fill(BUYER, intent, signature, 40), "first fill failed");
        require(market.intentRemaining(intent) == MAX_AMOUNT - 40, "remaining after first fill");
        require(_fill(OTHER_BUYER, intent, signature, 60), "second fill failed");
        require(market.intentRemaining(intent) == 0, "intent not exhausted");

        require(asset.balanceOf(BUYER) == 40, "first buyer amount");
        require(asset.balanceOf(OTHER_BUYER) == 60, "second buyer amount");
        require(!_fill(BUYER, intent, signature, 1), "an exhausted intent was filled again");
    }

    function testAFillBeyondTheAuthorizedMaximumIsRejectedWhole() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(!_fill(BUYER, intent, signature, MAX_AMOUNT + 1), "overfill accepted");
        require(asset.balanceOf(BUYER) == 0, "overfill moved fractions");

        require(_fill(BUYER, intent, signature, MAX_AMOUNT - 1), "fill to one below max failed");
        // Not clipped to what is left: the excess fill is refused outright.
        require(!_fill(OTHER_BUYER, intent, signature, 2), "a fill past the maximum was clipped");
        require(asset.balanceOf(OTHER_BUYER) == 0, "clipped fill moved fractions");
    }

    /// The ruling's second stated consequence: an authorization is not a transfer, so the same
    /// tokens can be authorized in several places at once.
    function testTheSameTokensMayCarrySeveralLiveAuthorizations() public {
        ArtFiMarket.SaleIntent memory first = _intent();
        ArtFiMarket.SaleIntent memory second = _intent();
        second.salt = 2;
        second.unitPrice = UNIT_PRICE * 2;
        bytes memory firstSignature = _sign(SELLER_KEY, first);
        bytes memory secondSignature = _sign(SELLER_KEY, second);

        require(_fill(BUYER, first, firstSignature, 10), "first authorization failed");
        require(_fill(OTHER_BUYER, second, secondSignature, 10), "second authorization failed");
        require(asset.balanceOf(BUYER) == 10, "first buyer amount");
        require(asset.balanceOf(OTHER_BUYER) == 10, "second buyer amount");
        require(market.intentRemaining(first) == MAX_AMOUNT - 10, "first intent miscounted");
        require(market.intentRemaining(second) == MAX_AMOUNT - 10, "second intent miscounted");
    }

    function testRevokedIntentCannotBeFilledByASignatureHolder() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        VM.prank(seller);
        market.revokeIntent(intent);

        require(!_fill(BUYER, intent, signature, 1), "a revoked intent was filled");
        require(market.intentRemaining(intent) == 0, "revocation did not exhaust the intent");
        require(asset.balanceOf(BUYER) == 0, "revoked intent moved fractions");
    }

    function testRevokingMidwayLeavesFilledAmountsAloneAndStopsTheRest() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(_fill(BUYER, intent, signature, 30), "first fill failed");
        VM.prank(seller);
        market.revokeIntent(intent);

        require(asset.balanceOf(BUYER) == 30, "a settled fill was undone");
        require(!_fill(OTHER_BUYER, intent, signature, 1), "a revoked intent was filled");
    }

    function testOnlyTheSellerMayRevoke() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        VM.prank(BUYER);
        (bool ok,) = address(market).call(abi.encodeCall(market.revokeIntent, (intent)));
        require(!ok, "a stranger revoked the seller's intent");
    }

    function testIncrementEpochInvalidatesEveryOutstandingIntent() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        VM.prank(seller);
        market.incrementSellerEpoch();

        require(!_fill(BUYER, intent, signature, 1), "an intent survived the epoch bump");
        require(market.sellerEpoch(seller) == 1, "epoch did not advance");
    }

    function testSignatureFromAnotherAccountIsRejected() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        require(!_fill(BUYER, intent, _sign(STRANGER_KEY, intent), 1), "a forged signature filled");
        require(asset.balanceOf(BUYER) == 0, "forged signature moved fractions");
    }

    /// The signature authorizes stated terms and nothing else.
    function testAlteredTermsInvalidateTheSignature() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        ArtFiMarket.SaleIntent memory altered = intent;
        altered.unitPrice = UNIT_PRICE - 1;
        require(!_fill(BUYER, altered, signature, 1), "a lowered price settled");

        altered = intent;
        altered.maxAmount = MAX_AMOUNT * 2;
        require(!_fill(BUYER, altered, signature, 1), "a raised maximum settled");
    }

    function testFillWindowBoundsAreEnforced() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        intent.startsAt = uint48(block.timestamp + 100);
        intent.endsAt = uint48(block.timestamp + 200);
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(!_fill(BUYER, intent, signature, 1), "filled before the window opened");
        VM.warp(intent.endsAt);
        require(!_fill(BUYER, intent, signature, 1), "filled at the exclusive upper bound");
        VM.warp(intent.startsAt);
        require(_fill(BUYER, intent, signature, 1), "a fill inside the window was refused");
    }

    function testTargetedIntentRejectsEveryOtherBuyer() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        intent.buyer = BUYER;
        bytes memory signature = _sign(SELLER_KEY, intent);

        require(!_fill(OTHER_BUYER, intent, signature, 1), "a targeted intent took another buyer");
        require(_fill(BUYER, intent, signature, 1), "the named buyer was refused");
    }

    function testSellerMayNotFillTheirOwnIntent() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);
        payment.mint(seller, 1_000);
        market.setPilotCap(seller, address(payment), 1_000_000);
        VM.prank(seller);
        payment.approve(address(market), type(uint256).max);
        require(!_fill(seller, intent, signature, 1), "the seller bought their own fractions");
    }

    function testZeroAmountAndZeroPriceAreRejected() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent), 0), "a zero-amount fill settled");

        intent.unitPrice = 0;
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent), 1), "a zero-price fill settled");
    }

    function testUnlistedTokensFailClosed() public {
        IntentToken stranger = new IntentToken("Stranger", "STR");
        stranger.mint(seller, 1_000);
        VM.prank(seller);
        stranger.approve(address(market), type(uint256).max);

        ArtFiMarket.SaleIntent memory intent = _intent();
        intent.assetToken = address(stranger);
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent), 1), "an unlisted asset settled");

        intent = _intent();
        intent.paymentToken = address(stranger);
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent), 1), "an unlisted payment settled");
    }

    function testFeeOnTransferPaymentIsRejected() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken();
        market.setTokenPermission(address(feeToken), false, true);
        market.setPilotCap(BUYER, address(feeToken), 1_000_000);
        feeToken.mint(BUYER, 1_000_000);
        VM.prank(BUYER);
        feeToken.approve(address(market), type(uint256).max);

        ArtFiMarket.SaleIntent memory intent = _intent();
        intent.paymentToken = address(feeToken);

        // Large enough that the token's 10% cut rounds to a nonzero shortfall. The check is exact,
        // so a fill small enough to round the fee away is not shorted and is not the case at issue.
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent), 10), "a fee token shorted seller");
        require(asset.balanceOf(BUYER) == 0, "fractions moved on a shorted payment");
    }

    /// The pilot cap is an existing safety control and still bites on this path.
    function testPilotCapFailsClosedOnTheIntentPath() public {
        market.setPilotCap(BUYER, address(payment), 10);
        ArtFiMarket.SaleIntent memory intent = _intent();
        require(!_fill(BUYER, intent, _sign(SELLER_KEY, intent), 4), "pilot cap bypassed");
        require(asset.balanceOf(BUYER) == 0, "capped fill moved fractions");
    }

    /// Pausing stops new fills. Because nothing is escrowed on this path it can strand nothing,
    /// and the seller keeps full control of their fractions while it is in force.
    function testPauseStopsFillsButNeverHoldsTheFractions() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);

        market.pause();
        require(!_fill(BUYER, intent, signature, 1), "a fill settled while paused");

        VM.prank(seller);
        require(asset.transfer(OTHER_BUYER, 500), "the holder transfer was rejected");
        require(asset.balanceOf(OTHER_BUYER) == 500, "the pause froze the holder");

        market.unpause();
        require(_fill(BUYER, intent, signature, 1), "unpausing did not restore settlement");
    }

    /// A seller must be able to withdraw an authorization while the market is paused; otherwise an
    /// administrative action keeps a live claim on their tokens.
    function testRevocationAndEpochBumpWorkWhilePaused() public {
        ArtFiMarket.SaleIntent memory intent = _intent();
        bytes memory signature = _sign(SELLER_KEY, intent);
        market.pause();

        VM.prank(seller);
        market.revokeIntent(intent);
        VM.prank(seller);
        market.incrementSellerEpoch();

        market.unpause();
        require(!_fill(BUYER, intent, signature, 1), "an intent revoked while paused was filled");
    }

    /// Whatever the terms, a settled fill leaves nothing behind in the contract.
    function testFuzzFillNeverLeavesValueInTheContract(uint64 unitPrice, uint8 amount) public {
        if (unitPrice == 0 || amount == 0) return;
        ArtFiMarket.SaleIntent memory intent = _intent();
        intent.unitPrice = unitPrice;
        intent.maxAmount = 255;
        bytes memory signature = _sign(SELLER_KEY, intent);

        uint256 payable_ = uint256(unitPrice) * amount;
        payment.mint(BUYER, payable_);
        market.setPilotCap(BUYER, address(payment), type(uint256).max);
        uint256 sellerBefore = payment.balanceOf(seller);

        require(_fill(BUYER, intent, signature, amount), "fill failed");
        require(payment.balanceOf(seller) == sellerBefore + payable_, "seller underpaid");
        require(payment.balanceOf(address(market)) == 0, "market retained payment");
        require(asset.balanceOf(address(market)) == 0, "market retained fractions");
        require(market.credits(seller, address(payment)) == 0, "a resting credit was created");
    }

    /// The browser signs what this contract verifies, or a fill fails for a reason no message
    /// explains. The same fixed intent, domain and digest are asserted in
    /// `apps/web/src/lib/fraction-intent.test.ts`, so a field renamed, reordered or retyped on
    /// either side breaks this constant on both sides rather than at fill time.
    function testDigestMatchesTheBrowserSigner() public view {
        bytes32 domainTypeHash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        bytes32 fixedDomainSeparator = keccak256(
            abi.encode(
                domainTypeHash,
                keccak256(bytes("ArtFi Fractions Market")),
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
                address(0x00000000000000000000000000000000000000d0),
                uint256(1000),
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
            digest == 0x9de0ca5c018685d7054b96dbce27834375413de39e1ec02bdcbb5862acde3cbf,
            "digest drifted from the browser signer"
        );
    }
}
