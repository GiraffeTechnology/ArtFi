// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {FractionalToken} from "../src/FractionalToken.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

contract UntrustedFractionalizer {
    function fractionalize(ArtFiVault vault) external returns (address) {
        return vault.fractionalize("Unauthorized", "NOPE", 100 ether, address(this));
    }
}

contract VaultFlowTest is IERC721Receiver {
    ArtFiRWA private nft;
    VaultFactory private factory;
    ArtFiVault private vault;
    UntrustedFractionalizer private untrusted;

    bytes32 private constant REQUEST_ID = keccak256("vault-request");

    function setUp() public {
        nft = new ArtFiRWA("ArtFi RWA", "ARWA", address(this), address(this), address(this));
        nft.safeMint(address(this), "ipfs://vault-test");
        factory = new VaultFactory(address(this), address(this), address(this));
        vault = ArtFiVault(
            factory.createVault(
                REQUEST_ID,
                "Material Memory Vault",
                nft,
                1,
                address(this),
                address(this),
                address(this)
            )
        );
        nft.approve(address(vault), 1);
        untrusted = new UntrustedFractionalizer();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(this);
    }

    function testFactoryReplayIsIdempotent() public view {
        require(factory.vaultForRequest(REQUEST_ID) == address(vault), "request lookup");
        bytes32 assetKey = keccak256(abi.encode(nft, uint256(1)));
        require(factory.vaultByAsset(assetKey) == address(vault), "asset lookup");
    }

    function testFactoryConflictingReplayReverts() public {
        (bool ok,) = address(factory)
            .call(
                abi.encodeCall(
                    factory.createVault,
                    (
                        REQUEST_ID,
                        "Different Vault",
                        nft,
                        1,
                        address(this),
                        address(this),
                        address(this)
                    )
                )
            );
        require(!ok, "conflicting replay accepted");
    }

    function testDepositAndFractionalizePreservesCustody() public {
        vault.deposit();
        address tokenAddress =
            vault.fractionalize("Material Memory Fractions", "MMF", 4_000 ether, address(this));
        FractionalToken token = FractionalToken(tokenAddress);

        require(nft.ownerOf(1) == address(vault), "vault lost custody");
        require(token.totalSupply() == 4_000 ether, "supply mismatch");
        require(token.balanceOf(address(this)) == 4_000 ether, "distribution mismatch");
        require(token.decimals() == 18, "decimal mismatch");
        require(vault.fractionalSupply() == token.totalSupply(), "vault supply mismatch");
    }

    function testFractionalizationIsSingleUse() public {
        vault.deposit();
        vault.fractionalize("Material Memory Fractions", "MMF", 4_000 ether, address(this));
        (bool ok,) = address(vault)
            .call(
                abi.encodeCall(
                    vault.fractionalize, ("Second Fractions", "SECOND", 1_000 ether, address(this))
                )
            );
        require(!ok, "second supply created");
    }

    function testUnauthorizedFractionalizationReverts() public {
        vault.deposit();
        (bool ok,) = address(untrusted).call(abi.encodeCall(untrusted.fractionalize, (vault)));
        require(!ok, "unauthorized fractionalization succeeded");
    }

    function testPausedVaultAllowsPreIssueEmergencyRecovery() public {
        vault.deposit();
        vault.pause();
        vault.emergencyRecover(address(this));
        require(nft.ownerOf(1) == address(this), "NFT was not recovered");
        require(!vault.deposited(), "deposit flag not cleared");
    }

    function testRecoveryAfterIssueIsForbidden() public {
        vault.deposit();
        vault.fractionalize("Material Memory Fractions", "MMF", 4_000 ether, address(this));
        vault.pause();
        (bool ok,) = address(vault).call(abi.encodeCall(vault.emergencyRecover, (address(this))));
        require(!ok, "fraction-backed NFT escaped custody");
        require(nft.ownerOf(1) == address(vault), "vault lost custody");
    }

    /// The fractions are the holder's asset. Every exit from `ArtFiMarket` and
    /// `RevenueDistributor` completes by transferring this token, so freezing it would
    /// re-create one layer down the trap PR #46 removed from `cancelListing` — and
    /// `ACCEPTANCE.md` §4.1 leaves nobody present to lift the freeze.
    ///
    /// `FractionalToken` no longer carries a pause surface at all, so the strongest part of
    /// this guarantee is enforced by the compiler: the previous version of this test called
    /// `token.pause()`, and that call no longer exists.
    function testAdministrativePauseNeverFreezesFractions() public {
        vault.deposit();
        FractionalToken token = FractionalToken(
            vault.fractionalize("Material Memory Fractions", "MMF", 4_000 ether, address(this))
        );
        vault.pause();
        require(token.transfer(address(0xBEEF), 1 ether), "paused vault froze a holder's fractions");
        require(token.balanceOf(address(0xBEEF)) == 1 ether, "fractions did not arrive");
    }

    /// The pause keeps its legitimate job. Asserting only the test above would be satisfied by
    /// a pause that had been reduced to doing nothing, which is not the change being made here.
    function testVaultPauseStillBlocksNewFractionalization() public {
        vault.deposit();
        vault.pause();
        (bool ok,) = address(vault)
            .call(
                abi.encodeCall(vault.fractionalize, ("Blocked", "BLK", 4_000 ether, address(this)))
            );
        require(!ok, "paused vault still fractionalized");
    }

    function testFuzzFixedSupply(uint96 rawSupply) public {
        uint256 supply = 1 ether + (uint256(rawSupply) % 1_000_000 ether);
        vault.deposit();
        FractionalToken token =
            FractionalToken(vault.fractionalize("Fuzz Fractions", "FUZZ", supply, address(this)));
        require(token.totalSupply() == supply, "fuzz supply mismatch");
        require(nft.ownerOf(1) == address(vault), "fuzz custody mismatch");
    }

    function fractionalizeInvariant(uint96 rawSupply) external {
        if (!vault.deposited()) {
            try vault.deposit() {} catch {}
        }
        uint256 supply = 1 ether + (uint256(rawSupply) % 1_000_000 ether);
        try vault.fractionalize("Invariant Fractions", "INV", supply, address(this)) {} catch {}
    }

    function invariantIssuedFractionsRemainBacked() public view {
        FractionalToken token = vault.fractionalToken();
        if (address(token) == address(0)) return;
        require(nft.ownerOf(1) == address(vault), "issued fractions lost NFT backing");
        require(token.totalSupply() == vault.fractionalSupply(), "issued supply changed");
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
