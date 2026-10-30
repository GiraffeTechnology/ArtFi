// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {ArtFiGovernor} from "../src/ArtFiGovernor.sol";
import {ArtFiDAOActions, IArtFiBuyoutPriceVerifier} from "../src/ArtFiDAOActions.sol";
import {FractionalToken} from "../src/FractionalToken.sol";

contract ThresholdFixtureNFT is ERC721 {
    constructor() ERC721("TEST_ONLY governance floor", "TGF") {}

    function mint(address to) external {
        _mint(to, 1);
    }
}

contract ThresholdFixturePrice is IArtFiBuyoutPriceVerifier {
    function verifyBuyoutPrice(address, uint256, uint48, uint48, uint8, uint32, bytes32)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// @dev Isolated TEST_ONLY vaults and roles; no real-world asset or deployment authority asserted.
contract GovernanceThresholdFloorTest {
    bytes4 private constant FLOOR_ERROR =
        bytes4(keccak256("InvalidProposalThreshold(uint256,uint256)"));

    function testZeroThresholdCannotDeploy() public {
        _assertRejected(1000 ether, 0);
    }

    function testBelowTenPercentCannotDeploy() public {
        _assertRejected(1000 ether, 99 ether);
    }

    function testFractionalUnitSupplyRoundsProposalFloorUp() public {
        _assertRejected(1 ether + 1, 1 ether / 10);
    }

    function testUndelegatedSupplyStillCountsTowardProposalFloor() public {
        (ArtFiVault vault, ArtFiDAOActions actions, TimelockController timelock) =
            _setup(1000 ether);
        FractionalToken votes = vault.fractionalToken();
        require(votes.transfer(address(0xA11CE), 900 ether), "fixture distribution failed");
        votes.delegate(address(this));
        require(
            votes.getVotes(address(this)) == 100 ether && votes.totalSupply() == 1000 ether,
            "fixture supply mismatch"
        );
        _reject(vault, actions, timelock, 99 ether, 100 ether);
    }

    function testExactTenPercentDirectDeploymentRemainsValid() public {
        _assertAccepted(1000 ether, 100 ether);
    }

    function testLargerConfiguredProposalThresholdRemainsValid() public {
        _assertAccepted(1000 ether, 125 ether);
    }

    function testFractionalUnitSupplyAcceptsCeilingThreshold() public {
        _assertAccepted(1 ether + 1, 1 ether / 10 + 1);
    }

    function testFuzzBelowCeilingThresholdCannotDeploy(uint96 rawSupply) public {
        uint256 supply = 1 ether + uint256(rawSupply);
        uint256 floor = (supply + 9) / 10;
        _assertRejected(supply, floor - 1);
    }

    function testFuzzCeilingThresholdRemainsValid(uint96 rawSupply) public {
        uint256 supply = 1 ether + uint256(rawSupply);
        _assertAccepted(supply, (supply + 9) / 10);
    }

    function _assertRejected(uint256 supply, uint256 proposed) private {
        (ArtFiVault vault, ArtFiDAOActions actions, TimelockController timelock) = _setup(supply);
        _reject(vault, actions, timelock, proposed, (supply + 9) / 10);
    }

    function _reject(
        ArtFiVault vault,
        ArtFiDAOActions actions,
        TimelockController timelock,
        uint256 proposed,
        uint256 minimum
    ) private {
        try new ArtFiGovernor(vault, actions, timelock, 1, 5, proposed, 4) returns (ArtFiGovernor) {
            revert("below-floor direct governance accepted");
        } catch (bytes memory reason) {
            require(reason.length == 68, "unexpected constructor failure");
            bytes4 selector;
            uint256 actual;
            uint256 required;
            assembly ("memory-safe") {
                selector := mload(add(reason, 0x20))
                actual := mload(add(reason, 0x24))
                required := mload(add(reason, 0x44))
            }
            require(
                selector == FLOOR_ERROR && actual == proposed && required == minimum,
                "wrong proposal floor error"
            );
        }
    }

    function _assertAccepted(uint256 supply, uint256 proposed) private {
        (ArtFiVault vault, ArtFiDAOActions actions, TimelockController timelock) = _setup(supply);
        ArtFiGovernor governor = new ArtFiGovernor(vault, actions, timelock, 1, 5, proposed, 4);
        require(governor.proposalThreshold() == proposed, "configured threshold changed");
        require(
            address(governor.rwaVault()) == address(vault)
                && address(governor.actionRegistry()) == address(actions),
            "governance association changed"
        );
        require(governor.rwaEligible(), "eligible vault changed");
    }

    function _setup(uint256 supply)
        private
        returns (ArtFiVault vault, ArtFiDAOActions actions, TimelockController timelock)
    {
        ThresholdFixtureNFT nft = new ThresholdFixtureNFT();
        nft.mint(address(this));
        vault = new ArtFiVault(
            "TEST_ONLY floor vault", nft, 1, address(this), address(this), address(this)
        );
        nft.approve(address(vault), 1);
        vault.deposit();
        vault.fractionalize("TEST_ONLY fractions", "TGF", supply, address(this));
        address[] memory noProposers = new address[](0);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(2, noProposers, executors, address(0));
        actions = new ArtFiDAOActions(vault, address(timelock), new ThresholdFixturePrice());
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}
