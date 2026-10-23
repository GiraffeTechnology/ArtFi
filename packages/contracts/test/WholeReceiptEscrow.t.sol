// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {WholeArtworkMarket} from "../src/WholeArtworkMarket.sol";
import {WholeReceiptEscrow, IWholeReceiptRegistrationVerifier} from "../src/WholeReceiptEscrow.sol";

interface ReceiptVm {
    function addr(uint256 key) external pure returns (address);
    function prank(address account) external;
    function sign(uint256 key, bytes32 digest) external pure returns (uint8, bytes32, bytes32);
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function expectRevert(bytes4 selector) external;
    function etch(address target, bytes calldata code) external;
}

contract TestOnlyReceiptNFT is ERC721 {
    constructor() ERC721("TEST_ONLY_NO_REAL_VALUE_RECEIPT", "TEST_RECEIPT") {}
    function mint(address holder, uint256 id) external { _mint(holder, id); }
}

contract TestOnlyReceiptPayment is ERC20 {
    address public feeFrom;
    address public feeTo;
    constructor() ERC20("TEST_ONLY_NO_REAL_VALUE_PAYMENT", "TEST_PAYMENT") {}
    function mint(address account, uint256 amount) external { _mint(account, amount); }
    function setFee(address from, address to) external { feeFrom = from; feeTo = to; }
    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0) && amount > 1 && (from == feeFrom || to == feeTo)) {
            super._update(from, to, amount - 1);
            super._update(from, address(0xFEE), 1);
        } else { super._update(from, to, amount); }
    }
}

/// @dev Synthetic proof fixture ONLY. Never a deployment adapter or Oracle evidence.
contract TestOnlyReceiptOracle is IWholeReceiptRegistrationVerifier {
    mapping(bytes32 => bytes32) private records;
    bool public unavailable;
    function allow(bytes32 id, bytes calldata evidence, bytes32 record) external {
        records[keccak256(abi.encode(id, evidence))] = record;
    }
    function setUnavailable(bool value) external { unavailable = value; }
    function verifyRegistration(bytes32 id, bytes calldata evidence) external view returns (bytes32) {
        require(!unavailable, "TEST_ONLY_ORACLE_UNAVAILABLE");
        return records[keccak256(abi.encode(id, evidence))];
    }
}

contract TestOnlyForwardingBuyer is IERC721Receiver {
    function buy(WholeReceiptEscrow escrow, WholeArtworkMarket.SaleIntent calldata sale,
        WholeReceiptEscrow.Correspondence calldata correspondence, bytes calldata signature) external {
        TestOnlyReceiptPayment(sale.paymentToken).approve(address(escrow), sale.price);
        escrow.fund(sale, correspondence, signature);
    }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        TestOnlyReceiptNFT(msg.sender).transferFrom(address(this), address(0xD), id);
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract WholeReceiptEscrowTest {
    ReceiptVm private constant VM = ReceiptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant A_KEY = 0xA110;
    uint256 private constant B_KEY = 0xB110;
    uint256 private constant C_KEY = 0xC110;
    address private a;
    address private b;
    address private c;
    address private d;
    WholeArtworkMarket private policy;
    WholeReceiptEscrow private escrow;
    TestOnlyReceiptOracle private oracle;
    TestOnlyReceiptNFT private nft;
    TestOnlyReceiptPayment private payment;

    function setUp() public {
        VM.chainId(31337);
        VM.warp(1000);
        a = VM.addr(A_KEY); b = VM.addr(B_KEY); c = VM.addr(C_KEY); d = address(0xD);
        policy = new WholeArtworkMarket(address(this), address(this), address(this));
        oracle = new TestOnlyReceiptOracle();
        escrow = new WholeReceiptEscrow(policy, oracle, address(oracle).codehash);
        nft = new TestOnlyReceiptNFT(); payment = new TestOnlyReceiptPayment();
        policy.setCollectionAllowed(address(nft), true);
        policy.setPaymentTokenAllowed(address(payment), true);
        nft.mint(a, 1);
        _prepare(a); _prepare(b); _prepare(c); _prepare(d);
    }

    function _prepare(address who) private {
        payment.mint(who, 1_000_000);
        VM.prank(who); payment.approve(address(escrow), type(uint256).max);
        VM.prank(who); nft.setApprovalForAll(address(escrow), true);
    }

    function _terms(address seller, address buyer, uint256 salt, uint256 amount)
        private view returns (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory correspondence)
    {
        sale = WholeArtworkMarket.SaleIntent(seller, address(nft), 1, address(payment), amount, buyer, salt,
            uint48(block.timestamp), uint48(block.timestamp + 1 days), policy.sellerEpoch(seller));
        correspondence = WholeReceiptEscrow.Correspondence({
            settlementId: keccak256(abi.encode("TEST_ONLY_SETTLEMENT", salt)),
            assetRecordHash: keccak256("TEST_ONLY_ARTWORK"), oracleSourceId: keccak256("TEST_ONLY_ORACLE"),
            requestHash: keccak256(abi.encode("TEST_ONLY_REQUEST", salt)),
            executionReferenceHash: keccak256(abi.encode("TEST_ONLY_JOURNAL", salt)),
            previousSegment: escrow.latestSegment(escrow.assetKey(address(nft), 1)),
            oldCertificateHash: keccak256(abi.encode("TEST_ONLY_PREVIOUS_CERT", salt)),
            warehouseReceiptHash: keccak256("TEST_ONLY_WAREHOUSE")
        });
    }

    function _signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fund(uint256 sellerKey, address buyer, uint256 salt, uint256 amount) private returns (bytes32 id) {
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(VM.addr(sellerKey), buyer, salt, amount);
        bytes memory signature = _signature(sellerKey, escrow.authorizationHash(sale, info));
        VM.prank(buyer); id = escrow.fund(sale, info, signature);
    }

    function _confirm(bytes32 id) private {
        bytes memory proof = abi.encode("TEST_ONLY_AUTHENTICATED_RECORD", id);
        oracle.allow(id, proof, keccak256(abi.encode("TEST_ONLY_CERT", id)));
        escrow.confirmRegistration(id, proof);
    }

    function testBuyerSpecificEscrowMovesOnlyArtworkAndExactBuyerFunds() public {
        bytes32 id = _fund(A_KEY, b, 1, 100);
        WholeReceiptEscrow.Segment memory stored = escrow.segment(id);
        require(nft.ownerOf(1) == b && payment.balanceOf(a) == 1_000_000, "premature seller payment");
        require(payment.balanceOf(b) == 999_900 && payment.balanceOf(address(escrow)) == 100, "funding mismatch");
        require(stored.buyer == b && stored.seller == a && stored.amount == 100 && !stored.paid, "wrong segment");
        VM.expectRevert(WholeReceiptEscrow.RegistrationUnavailable.selector); escrow.paySeller(id);
    }

    function testAuthorizationMatchesBrowserFixedDigest() public {
        VM.chainId(560048);
        address verifyingContract = address(0x3333333333333333333333333333333333333333);
        VM.etch(verifyingContract, address(escrow).code);
        WholeArtworkMarket.SaleIntent memory sale = WholeArtworkMarket.SaleIntent(
            address(bytes20(hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
            address(0x1111111111111111111111111111111111111111), 7,
            address(0x2222222222222222222222222222222222222222), 100,
            address(bytes20(hex"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")), 1, 1000, 2000, 0);
        uint256 unit = type(uint256).max / 15;
        WholeReceiptEscrow.Correspondence memory info = WholeReceiptEscrow.Correspondence(
            bytes32(unit), bytes32(unit*2), bytes32(unit*3), bytes32(unit*4), bytes32(unit*5),
            bytes32(0), bytes32(unit*6), bytes32(unit*7));
        require(WholeReceiptEscrow(verifyingContract).authorizationHash(sale,info)==
            0x4749d8a2de0aada4dc2cb8edf179c1dac56ee0a57310920f40b6806f40b295a9,"browser/domain digest mismatch");
    }

    function testIndependentPrefixPaymentWhileLaterOwnerIsD() public {
        bytes32 ab = _fund(A_KEY, b, 1, 100);
        bytes32 bc = _fund(B_KEY, c, 2, 200);
        bytes32 cd = _fund(C_KEY, d, 3, 300);
        require(nft.ownerOf(1) == d, "TEST_ONLY final owner");
        _confirm(bc); escrow.paySeller(bc);
        require(payment.balanceOf(b) == 1_000_100 && escrow.totalEscrowed(address(payment)) == 400, "C history blocked by D");
        _confirm(ab); escrow.paySeller(ab);
        oracle.setUnavailable(true);
        require(escrow.segment(ab).paid && escrow.segment(bc).paid, "settled prefix lost");
        VM.expectRevert(WholeReceiptEscrow.RegistrationUnavailable.selector); escrow.paySeller(cd);
        require(escrow.totalEscrowed(address(payment)) == 300, "unconfirmed suffix released");
    }

    function testExactConfirmationReplayIsNoOpAndConflictCannotChangePaidPrefix() public {
        bytes32 id = _fund(A_KEY, b, 1, 100);
        _confirm(id); escrow.paySeller(id);
        bytes memory proof = abi.encode("TEST_ONLY_AUTHENTICATED_RECORD", id);
        oracle.setUnavailable(true);
        escrow.confirmRegistration(id, proof);
        VM.expectRevert(WholeReceiptEscrow.RegistrationConflict.selector); escrow.confirmRegistration(id, hex"1234");
        VM.expectRevert(WholeReceiptEscrow.AlreadyPaid.selector); escrow.paySeller(id);
        require(payment.balanceOf(a) == 1_000_100 && escrow.totalEscrowed(address(payment)) == 0, "duplicate paid");
    }

    function testAtomicSaleSignatureCannotAuthorizeDelayedPayment() public {
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(a,b,1,100);
        bytes memory atomicSignature = _signature(A_KEY, policy.intentHash(sale));
        VM.prank(b); VM.expectRevert(WholeReceiptEscrow.InvalidAuthorization.selector);
        escrow.fund(sale, info, atomicSignature);
    }

    function testNamedBuyerCannotBeSubstitutedAndSellerCannotSelfTrade() public {
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(a,b,1,100);
        bytes memory signature = _signature(A_KEY, escrow.authorizationHash(sale,info));
        VM.prank(c); VM.expectRevert(WholeReceiptEscrow.InvalidTerms.selector); escrow.fund(sale,info,signature);
        sale.buyer = a;
        signature = _signature(A_KEY,escrow.authorizationHash(sale,info));
        VM.prank(a); VM.expectRevert(WholeReceiptEscrow.InvalidTerms.selector); escrow.fund(sale,info,signature);
    }

    function testEveryCorrespondenceFieldIsSigned() public {
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(a,b,1,100);
        bytes memory signature = _signature(A_KEY,escrow.authorizationHash(sale,info));
        for(uint256 i; i<7; ++i) {
            WholeReceiptEscrow.Correspondence memory changed = _copy(info);
            if(i==0) changed.settlementId = keccak256("other");
            if(i==1) changed.assetRecordHash = keccak256("other");
            if(i==2) changed.oracleSourceId = keccak256("other");
            if(i==3) changed.requestHash = keccak256("other");
            if(i==4) changed.executionReferenceHash = keccak256("other");
            if(i==5) changed.oldCertificateHash = keccak256("other");
            if(i==6) changed.warehouseReceiptHash = keccak256("other");
            VM.prank(b); VM.expectRevert(WholeReceiptEscrow.InvalidAuthorization.selector); escrow.fund(sale,changed,signature);
        }
        require(nft.ownerOf(1)==a && escrow.totalEscrowed(address(payment))==0, "mutation changed state");
    }
    function _copy(WholeReceiptEscrow.Correspondence memory info) private pure returns(WholeReceiptEscrow.Correspondence memory) {
        return abi.decode(abi.encode(info),(WholeReceiptEscrow.Correspondence));
    }

    function testMismatchedOrUnauthenticatedOracleProofCannotReleaseFunds() public {
        bytes32 ab = _fund(A_KEY,b,1,100); bytes32 bc = _fund(B_KEY,c,2,200);
        bytes memory proof = abi.encode("TEST_ONLY_PROOF",ab);
        oracle.allow(ab,proof,keccak256("TEST_ONLY_RECORD"));
        VM.expectRevert(WholeReceiptEscrow.RegistrationUnavailable.selector); escrow.confirmRegistration(bc,proof);
        VM.expectRevert(WholeReceiptEscrow.RegistrationUnavailable.selector); escrow.confirmRegistration(ab,hex"1234");
        require(escrow.totalEscrowed(address(payment))==300 && !escrow.segment(ab).paid, "unauthenticated release");
    }

    function testSharedPolicyPauseStopsFundingButDoesNotStrandConfirmedPayout() public {
        bytes32 id = _fund(A_KEY,b,1,100); _confirm(id);
        policy.pause();
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(b,c,2,200);
        bytes memory signature = _signature(B_KEY,escrow.authorizationHash(sale,info));
        VM.prank(c); VM.expectRevert(WholeReceiptEscrow.InvalidTerms.selector); escrow.fund(sale,info,signature);
        escrow.paySeller(id);
        require(payment.balanceOf(a)==1_000_100, "pause trapped confirmed payout");
    }

    function testRevocationAndExistingSellerEpochInvalidateUnfundedAuthorization() public {
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(a,b,1,100);
        bytes memory signature = _signature(A_KEY,escrow.authorizationHash(sale,info));
        VM.prank(a); escrow.revoke(sale,info);
        VM.prank(b); VM.expectRevert(WholeReceiptEscrow.AuthorizationUnavailable.selector); escrow.fund(sale,info,signature);
        info.settlementId=keccak256("TEST_ONLY_NEW");
        signature=_signature(A_KEY,escrow.authorizationHash(sale,info));
        VM.prank(a); policy.incrementEpoch();
        VM.prank(b); VM.expectRevert(WholeReceiptEscrow.InvalidTerms.selector); escrow.fund(sale,info,signature);
    }

    function testInboundFeeTokenRollsBackArtworkAndAllAccounting() public {
        payment.setFee(address(0),address(escrow));
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(a,b,1,100);
        bytes32 id=escrow.authorizationHash(sale,info); bytes memory signature=_signature(A_KEY,id);
        VM.prank(b); VM.expectRevert(WholeReceiptEscrow.TransferAmountMismatch.selector); escrow.fund(sale,info,signature);
        require(nft.ownerOf(1)==a && !escrow.authorizationUsed(id) && payment.balanceOf(b)==1_000_000, "funding not atomic");
        require(payment.balanceOf(address(escrow))==0 && escrow.totalEscrowed(address(payment))==0, "custody mismatch");
    }

    function testOutboundFeeKeepsRegisteredUnpaidStateAndExactRetry() public {
        bytes32 id=_fund(A_KEY,b,1,100); _confirm(id);
        payment.setFee(address(escrow),address(0));
        VM.expectRevert(WholeReceiptEscrow.TransferAmountMismatch.selector); escrow.paySeller(id);
        require(!escrow.segment(id).paid && escrow.segment(id).registrationRecordHash!=bytes32(0), "registration lost");
        require(escrow.totalEscrowed(address(payment))==100 && payment.balanceOf(a)==1_000_000, "partial payout");
        payment.setFee(address(0),address(0)); escrow.paySeller(id);
        require(escrow.segment(id).paid && payment.balanceOf(a)==1_000_100, "retry not exact");
    }

    function testReceiverCannotForwardArtworkDuringFundingCallback() public {
        TestOnlyForwardingBuyer forwarder = new TestOnlyForwardingBuyer();
        payment.mint(address(forwarder),100);
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(a,address(forwarder),1,100);
        bytes memory signature=_signature(A_KEY,escrow.authorizationHash(sale,info));
        VM.expectRevert(WholeReceiptEscrow.ArtworkTransferMismatch.selector); forwarder.buy(escrow,sale,info,signature);
        require(nft.ownerOf(1)==a && payment.balanceOf(address(forwarder))==100, "callback not atomic");
    }

    function testDuplicateRequestAndForeignPredecessorCannotCreateNewSegment() public {
        bytes32 ab=_fund(A_KEY,b,1,100);
        (WholeArtworkMarket.SaleIntent memory sale, WholeReceiptEscrow.Correspondence memory info) = _terms(b,c,1,100);
        bytes memory signature=_signature(B_KEY,escrow.authorizationHash(sale,info));
        VM.prank(c); VM.expectRevert(WholeReceiptEscrow.InvalidTerms.selector); escrow.fund(sale,info,signature);
        (sale,info)=_terms(b,c,2,100); info.previousSegment=bytes32(0);
        signature=_signature(B_KEY,escrow.authorizationHash(sale,info));
        VM.prank(c); VM.expectRevert(WholeReceiptEscrow.InvalidTerms.selector); escrow.fund(sale,info,signature);
        require(escrow.latestSegment(escrow.assetKey(address(nft),1))==ab, "lineage changed");
    }

    function testDeploymentRequiresTestChainAndExactVerifierCode() public {
        VM.expectRevert(WholeReceiptEscrow.InvalidConfiguration.selector);
        new WholeReceiptEscrow(policy,oracle,bytes32(uint256(1)));
        VM.chainId(1);
        VM.expectRevert(WholeReceiptEscrow.InvalidConfiguration.selector);
        new WholeReceiptEscrow(policy,oracle,address(oracle).codehash);
    }

    function testNoAdministrativeRefundOrForcedRollbackSurface() public {
        bytes32 id=_fund(A_KEY,b,1,100);
        (bool refunded,)=address(escrow).call(abi.encodeWithSignature("refundBuyer(bytes32)",id));
        (bool rolledBack,)=address(escrow).call(abi.encodeWithSignature("rollback(bytes32)",id));
        require(!refunded && !rolledBack && nft.ownerOf(1)==b && escrow.totalEscrowed(address(payment))==100,"invented recovery authority");
    }

    function testFuzzExactPaymentNeverConsumesAnotherSegment(uint96 seed) public {
        uint256 amount=uint256(seed)%100_000+1;
        bytes32 ab=_fund(A_KEY,b,1,amount); bytes32 bc=_fund(B_KEY,c,2,amount+1);
        _confirm(ab); escrow.paySeller(ab);
        require(payment.balanceOf(address(escrow))==amount+1 && escrow.totalEscrowed(address(payment))==amount+1,"cross-segment spending");
        require(!escrow.segment(bc).paid && payment.balanceOf(a)==1_000_000+amount,"wrong payout");
    }
}

contract TestOnlyReceiptEscrowHandler {
    ReceiptVm private constant VM = ReceiptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SELLER_KEY = 0xF001;
    address private immutable seller;
    address private constant BUYER = address(0xB001);
    WholeArtworkMarket private policy;
    TestOnlyReceiptOracle private oracle;
    TestOnlyReceiptNFT private nft;
    TestOnlyReceiptPayment public payment;
    WholeReceiptEscrow public escrow;
    bytes32[] private ids;
    uint256 public calls;
    uint256 public totalFunded;
    uint256 public totalPaid;

    constructor() {
        seller=VM.addr(SELLER_KEY);
        policy=new WholeArtworkMarket(address(this),address(this),address(this));
        oracle=new TestOnlyReceiptOracle();
        escrow=new WholeReceiptEscrow(policy,oracle,address(oracle).codehash);
        nft=new TestOnlyReceiptNFT(); payment=new TestOnlyReceiptPayment();
        policy.setCollectionAllowed(address(nft),true);policy.setPaymentTokenAllowed(address(payment),true);
        VM.prank(seller);nft.setApprovalForAll(address(escrow),true);
        VM.prank(BUYER);payment.approve(address(escrow),type(uint256).max);
    }
    function fund(uint96 seed) external {
        calls++;
        if(ids.length>=128) return;
        uint256 tokenId=ids.length+1;
        uint256 amount=uint256(seed)%100_000+1;
        nft.mint(seller,tokenId);payment.mint(BUYER,amount);
        WholeArtworkMarket.SaleIntent memory sale=WholeArtworkMarket.SaleIntent(seller,address(nft),tokenId,address(payment),amount,BUYER,tokenId,uint48(block.timestamp),uint48(block.timestamp+1 days),0);
        WholeReceiptEscrow.Correspondence memory info=WholeReceiptEscrow.Correspondence(
            keccak256(abi.encode("TEST_ONLY_SETTLEMENT",tokenId)),keccak256(abi.encode("TEST_ONLY_ASSET",tokenId)),
            keccak256("TEST_ONLY_ORACLE"),keccak256(abi.encode("TEST_ONLY_REQUEST",tokenId)),
            keccak256(abi.encode("TEST_ONLY_EXECUTION",tokenId)),bytes32(0),keccak256("TEST_ONLY_OLD_CERT"),keccak256("TEST_ONLY_WAREHOUSE"));
        bytes32 id=escrow.authorizationHash(sale,info);
        (uint8 v,bytes32 r,bytes32 s)=VM.sign(SELLER_KEY,id);
        VM.prank(BUYER);escrow.fund(sale,info,abi.encodePacked(r,s,v));
        ids.push(id);totalFunded+=amount;
    }
    function confirm(uint256 seed) external {
        calls++;
        if(ids.length==0)return;
        bytes32 id=ids[seed%ids.length];
        bytes memory proof=abi.encode("TEST_ONLY_PROOF",id);
        oracle.allow(id,proof,keccak256(abi.encode("TEST_ONLY_RECORD",id)));
        escrow.confirmRegistration(id,proof);
    }
    function pay(uint256 seed) external {
        calls++;
        if(ids.length==0)return;
        bytes32 id=ids[seed%ids.length];
        WholeReceiptEscrow.Segment memory current=escrow.segment(id);
        if(current.paid || current.registrationRecordHash==bytes32(0))return;
        escrow.paySeller(id);totalPaid+=current.amount;
    }
}

contract WholeReceiptEscrowInvariantTest {
    ReceiptVm private constant VM = ReceiptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestOnlyReceiptEscrowHandler private handler;
    function setUp() public {
        VM.chainId(31337);VM.warp(1000);
        handler=new TestOnlyReceiptEscrowHandler();
        handler.fund(10);
    }
    function targetContracts() external view returns(address[] memory result) {
        result=new address[](1);result[0]=address(handler);
    }
    function invariant_CustodyEqualsFundedMinusExactPayments() public view {
        require(handler.totalPaid()<=handler.totalFunded(),"paid exceeds funded");
        uint256 remaining=handler.totalFunded()-handler.totalPaid();
        require(handler.payment().balanceOf(address(handler.escrow()))==remaining,"custody drift");
        require(handler.escrow().totalEscrowed(address(handler.payment()))==remaining,"ledger drift");
    }
    function afterInvariant() public view { require(handler.calls()>1,"campaign did not call handler"); }
}
