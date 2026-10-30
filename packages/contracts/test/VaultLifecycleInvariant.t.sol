// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {FractionalToken} from "../src/FractionalToken.sol";

interface VaultLifecycleVm {
    function prank(address sender) external;
}

/// @dev TEST_ONLY NFT collection and actors; no real-world backing is asserted.
contract LifecycleNFT is ERC721 {
    constructor() ERC721("Lifecycle fixture", "LIFE") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract VaultLifecycleHandler {
    VaultLifecycleVm private constant VM =
        VaultLifecycleVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address[3] private actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    LifecycleNFT private nft;
    VaultFactory private factory;
    ArtFiVault[3] private vaults;
    FractionalToken[3] private tokens;
    // Independent model: 0=original wallet, 1=unissued custody, 2=issued custody.
    uint8[3] private phase;
    bool[3] private paused;
    bool[3] private everDeposited;
    uint256[3] private supply;
    mapping(uint256 vaultIndex => mapping(uint256 actorIndex => uint256 amount)) private shares;

    constructor() {
        nft = new LifecycleNFT();
        factory = new VaultFactory(address(this), address(this), address(this));
        for (uint256 i; i < 3; ++i) {
            nft.mint(actors[i], i + 1);
            vaults[i] = ArtFiVault(
                factory.createVault(
                    _request(i),
                    "Lifecycle fixture vault",
                    nft,
                    i + 1,
                    address(this),
                    address(this),
                    address(this)
                )
            );
        }
    }

    function deposit(uint8 rawVault) public {
        uint256 i = uint256(rawVault) % 3;
        if (phase[i] != 0 || paused[i]) return;
        VM.prank(actors[i]);
        nft.approve(address(vaults[i]), i + 1);
        VM.prank(actors[i]);
        vaults[i].deposit();
        phase[i] = 1;
        everDeposited[i] = true;
    }

    function issue(uint8 rawVault, uint96 rawSupply) public {
        uint256 i = uint256(rawVault) % 3;
        if (phase[i] != 1 || paused[i]) return;
        uint256 amount = 1 ether + uint256(rawSupply) % 1000 ether;
        tokens[i] = FractionalToken(
            vaults[i].fractionalize("Lifecycle fractions", "LCF", amount, actors[i])
        );
        phase[i] = 2;
        supply[i] = amount;
        shares[i][i] = amount;
    }

    function moveFractions(uint8 rawVault, uint8 rawFrom, uint8 rawTo, uint96 rawAmount) external {
        uint256 i = uint256(rawVault) % 3;
        uint256 from = uint256(rawFrom) % 3;
        uint256 to = (from + 1 + uint256(rawTo) % 2) % 3;
        uint256 available = shares[i][from];
        if (phase[i] != 2 || available == 0) return;
        uint256 amount = 1 + uint256(rawAmount) % available;
        VM.prank(actors[from]);
        require(tokens[i].transfer(actors[to], amount), "fraction transfer failed");
        shares[i][from] -= amount;
        shares[i][to] += amount;
    }

    function setPaused(uint8 rawVault, bool next) public {
        uint256 i = uint256(rawVault) % 3;
        if (paused[i] == next) return;
        if (next) vaults[i].pause();
        else vaults[i].unpause();
        paused[i] = next;
    }

    function recover(uint8 rawVault) public {
        uint256 i = uint256(rawVault) % 3;
        if (phase[i] != 1 || !paused[i]) return;
        vaults[i].emergencyRecover(actors[i]);
        phase[i] = 0;
    }

    function unauthorizedIssue(uint8 rawVault) external {
        uint256 i = uint256(rawVault) % 3;
        VM.prank(address(0xBAD));
        (bool ok,) = address(vaults[i])
            .call(
                abi.encodeCall(
                    vaults[i].fractionalize, ("Unauthorized fractions", "BAD", 10 ether, actors[i])
                )
            );
        require(!ok, "unprivileged issuance accepted");
    }

    function forbiddenRecovery(uint8 rawVault) external {
        uint256 i = uint256(rawVault) % 3;
        if (!paused[i] || phase[i] == 0) return;
        address recipient = phase[i] == 2 ? actors[i] : actors[(i + 1) % 3];
        (bool ok,) =
            address(vaults[i]).call(abi.encodeCall(vaults[i].emergencyRecover, (recipient)));
        require(!ok, "forbidden recovery accepted");
    }

    function assertCustodyAndSupply() public view {
        for (uint256 i; i < 3; ++i) {
            ArtFiVault vault = vaults[i];
            require(vault.deposited() == (phase[i] != 0), "deposit state drift");
            require(vault.paused() == paused[i], "pause state drift");
            require(
                nft.ownerOf(i + 1) == (phase[i] == 0 ? actors[i] : address(vault)),
                "NFT custody drift"
            );
            require(
                vault.originalOwner() == (everDeposited[i] ? actors[i] : address(0)),
                "original owner drift"
            );
            require(factory.vaultForRequest(_request(i)) == address(vault), "request binding drift");
            require(
                factory.vaultByAsset(keccak256(abi.encode(nft, i + 1))) == address(vault),
                "asset binding drift"
            );
            require(address(vault.fractionalToken()) == address(tokens[i]), "issued token changed");
            require(vault.fractionalSupply() == supply[i], "recorded supply drift");
            if (phase[i] != 2) {
                require(address(tokens[i]) == address(0) && supply[i] == 0, "unissued token exists");
                continue;
            }
            require(tokens[i].totalSupply() == supply[i], "fixed supply changed");
            uint256 total;
            for (uint256 a; a < 3; ++a) {
                require(tokens[i].balanceOf(actors[a]) == shares[i][a], "holder balance drift");
                total += shares[i][a];
            }
            require(total == supply[i], "fraction conservation");
        }
    }

    function finishAllVaults() external {
        for (uint8 i; i < 3; ++i) {
            setPaused(i, false);
            deposit(i);
            issue(i, 100 ether);
            require(phase[i] == 2, "remaining valid vault cannot issue");
        }
        assertCustodyAndSupply();
    }

    function _request(uint256 index) private pure returns (bytes32) {
        return keccak256(abi.encode("test-only-lifecycle-vault", index));
    }
}

contract VaultLifecycleInvariantTest {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }
    VaultLifecycleHandler private handler;

    function setUp() public {
        handler = new VaultLifecycleHandler();
    }

    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function targetSelectors() external view returns (FuzzSelector[] memory targets) {
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.issue.selector;
        selectors[2] = handler.moveFractions.selector;
        selectors[3] = handler.setPaused.selector;
        selectors[4] = handler.recover.selector;
        selectors[5] = handler.unauthorizedIssue.selector;
        selectors[6] = handler.forbiddenRecovery.selector;
        targets = new FuzzSelector[](1);
        targets[0] = FuzzSelector(address(handler), selectors);
    }

    function invariantCustodyFixedSupplyAndIndependentVaults() public view {
        handler.assertCustodyAndSupply();
    }

    function afterInvariant() public {
        handler.finishAllVaults();
    }
}
