// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {FractionalToken} from "../src/FractionalToken.sol";

/// @dev TEST_ONLY nonconforming collection behaviors; not a real asset or issuer.
contract CustodyStateNFT is ERC721 {
    uint8 public mode;
    address public watchedVault;
    address private constant DIVERTED = address(0xD1A);

    constructor() ERC721("Custody fixture", "CUST") {}

    function mint(address owner) external {
        _mint(owner, 1);
    }

    function setMode(address vault, uint8 next) external {
        watchedVault = vault;
        mode = next;
    }

    function fakeReceipt(address vault, address from) external returns (bytes4) {
        return IERC721Receiver(vault).onERC721Received(msg.sender, from, 1, "");
    }

    function forceMove(address to) external {
        _transfer(ownerOf(1), to, 1);
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data)
        public
        override
    {
        if (mode == 1 && to == watchedVault) {
            IERC721Receiver(to).onERC721Received(msg.sender, from, id, data);
            return;
        }
        if (mode == 3 && from == watchedVault) return;
        super.safeTransferFrom(from, to, id, data);
        if (mode == 2 && to == watchedVault) _transfer(to, DIVERTED, id);
    }
}

contract ForwardingCustodyOwner is IERC721Receiver {
    bool public forward;

    function deposit(CustodyStateNFT nft, ArtFiVault vault) external {
        nft.approve(address(vault), 1);
        vault.deposit();
    }

    function setForward() external {
        forward = true;
    }

    function onERC721Received(address, address, uint256 id, bytes calldata)
        external
        override
        returns (bytes4)
    {
        if (forward) ERC721(msg.sender).transferFrom(address(this), address(0xFEED), id);
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract VaultCustodyStateTest is IERC721Receiver {
    CustodyStateNFT private nft;
    ArtFiVault private vault;

    function setUp() public {
        nft = new CustodyStateNFT();
        nft.mint(address(this));
        vault = new ArtFiVault(
            "Custody fixture vault", nft, 1, address(this), address(this), address(this)
        );
        nft.approve(address(vault), 1);
    }

    function testCallbackOnlyDepositCannotEstablishCustody() public {
        _rejectDeposit(1);
    }

    function testTransferDivertedAfterCallbackRollsBackDeposit() public {
        _rejectDeposit(2);
    }

    function testDirectCollectionCallbackWithoutCustodyRejected() public {
        (bool ok, bytes memory reason) =
            address(nft).call(abi.encodeCall(nft.fakeReceipt, (address(vault), address(this))));
        _invalidNFT(ok, reason);
        _assertNeverDeposited();
    }

    function testLostCustodyCannotIssueFractionalSupply() public {
        vault.deposit();
        nft.forceMove(address(0xBEEF));
        (bool ok, bytes memory reason) = address(vault)
            .call(
                abi.encodeCall(
                    vault.fractionalize, ("Custody fractions", "CUST", 100 ether, address(this))
                )
            );
        _invalidNFT(ok, reason);
        require(vault.deposited() && vault.originalOwner() == address(this), "history lost");
        require(nft.ownerOf(1) == address(0xBEEF), "unauthorized ownership rewrite");
        require(
            address(vault.fractionalToken()) == address(0) && vault.fractionalSupply() == 0,
            "unbacked supply issued"
        );
    }

    function testNoOpRecoveryPreservesDepositAndCanRetry() public {
        vault.deposit();
        vault.pause();
        nft.setMode(address(vault), 3);
        (bool ok, bytes memory reason) =
            address(vault).call(abi.encodeCall(vault.emergencyRecover, (address(this))));
        _invalidNFT(ok, reason);
        require(
            vault.deposited() && vault.originalOwner() == address(this),
            "failed recovery consumed deposit"
        );
        require(nft.ownerOf(1) == address(vault), "custody changed on failed recovery");
        nft.setMode(address(vault), 0);
        vault.emergencyRecover(address(this));
        require(
            !vault.deposited() && nft.ownerOf(1) == address(this), "exact recovery retry failed"
        );
    }

    function testDirectSafeTransferSupportsExactCustodyAndSingleSupply() public {
        nft.safeTransferFrom(address(this), address(vault), 1);
        require(
            vault.deposited() && vault.originalOwner() == address(this),
            "direct transfer not recorded"
        );
        FractionalToken token = FractionalToken(
            vault.fractionalize("Custody fractions", "CUST", 100 ether, address(this))
        );
        require(nft.ownerOf(1) == address(vault), "fractionalization lost custody");
        require(
            token.totalSupply() == 100 ether && token.balanceOf(address(this)) == 100 ether,
            "supply mismatch"
        );
    }

    function testFuzzNoncustodialDepositLeavesNoFractionState(uint8 rawMode) public {
        _rejectDeposit(rawMode % 2 + 1);
    }

    function testOriginalOwnerMayForwardDuringRecoveryCallback() public {
        CustodyStateNFT separateNFT = new CustodyStateNFT();
        ForwardingCustodyOwner owner = new ForwardingCustodyOwner();
        separateNFT.mint(address(owner));
        ArtFiVault separateVault = new ArtFiVault(
            "Forwarding owner vault", separateNFT, 1, address(this), address(this), address(this)
        );
        owner.deposit(separateNFT, separateVault);
        separateVault.pause();
        owner.setForward();
        separateVault.emergencyRecover(address(owner));
        require(
            !separateVault.deposited() && separateNFT.ownerOf(1) == address(0xFEED),
            "owner receiver forwarding blocked"
        );
        require(
            separateVault.originalOwner() == address(owner),
            "administrator changed recipient identity"
        );
    }

    function _rejectDeposit(uint8 mode) private {
        nft.setMode(address(vault), mode);
        (bool ok, bytes memory reason) = address(vault).call(abi.encodeCall(vault.deposit, ()));
        _invalidNFT(ok, reason);
        _assertNeverDeposited();
    }

    function _assertNeverDeposited() private view {
        require(!vault.deposited() && vault.originalOwner() == address(0), "false custody recorded");
        require(nft.ownerOf(1) == address(this), "failed deposit moved artwork");
        require(
            address(vault.fractionalToken()) == address(0) && vault.fractionalSupply() == 0,
            "fraction state created"
        );
    }

    function _invalidNFT(bool ok, bytes memory reason) private pure {
        require(!ok, "missing custody accepted");
        require(
            reason.length >= 4 && bytes4(reason) == ArtFiVault.InvalidNFT.selector,
            "wrong failure type"
        );
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IERC721Receiver.onERC721Received.selector;
    }
}
