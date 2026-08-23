// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {ArtFiDAOActions} from "../src/ArtFiDAOActions.sol";
import {ArtFiGovernanceBootstrap} from "../src/ArtFiGovernanceBootstrap.sol";
import {ArtFiGovernor} from "../src/ArtFiGovernor.sol";
import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {FractionalToken} from "../src/FractionalToken.sol";
import {ArtFiA02TestAsset} from "../src/testonly/ArtFiA02TestAsset.sol";
import {ArtFiA02TestPriceVerifier} from "../src/testonly/ArtFiA02TestPriceVerifier.sol";

interface A02Vm {
    function chainId(uint256 newChainId) external;
    function prank(address sender) external;
    function roll(uint256 blockNumber) external;
    function warp(uint256 timestamp) external;
}

contract A02BaseSepoliaDAOTest {
    A02Vm private constant VM = A02Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    address private constant ARTFI1 = 0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089;
    address private constant ARTFI2 = 0xDE3c1D455c2CCe1bAcf1e70aAC7fA3B8cCb1ec2B;
    bytes32 private constant METADATA_HASH = keccak256("a02-test-only-metadata");
    bytes32 private constant PHYSICAL_MAPPING_HASH = keccak256("a02-test-physical-mapping");
    bytes32 private constant BUYOUT_EVIDENCE_HASH = keccak256("a02-test-buyout-evidence");
    string private constant METADATA_URI =
        "https://io.artcch.com/nft/metadata/base-sepolia/test-only/a02.json";

    struct Stack {
        ArtFiA02TestAsset editions;
        ArtFiRWA rwa;
        ArtFiVault vault;
        FractionalToken votes;
        ArtFiGovernanceBootstrap bootstrap;
        ArtFiGovernor governor;
        ArtFiDAOActions actions;
    }

    function testA02IsFixedOneHundredAndMappedToVaultedRWA() public {
        Stack memory deployed = _deploy(0);

        require(deployed.editions.BASE_SEPOLIA_CHAIN_ID() == BASE_SEPOLIA_CHAIN_ID, "chain gate");
        require(
            deployed.editions.totalSupply(deployed.editions.TOKEN_ID()) == 100, "edition supply"
        );
        require(deployed.editions.balanceOf(ARTFI1, deployed.editions.TOKEN_ID()) == 100, "issuer");
        require(deployed.editions.metadataSha256() == METADATA_HASH, "metadata commitment");
        require(
            deployed.editions.physicalMappingEvidenceSha256() == PHYSICAL_MAPPING_HASH,
            "physical mapping commitment"
        );
        require(deployed.vault.deposited(), "RWA not deposited");
        require(deployed.rwa.ownerOf(1) == address(deployed.vault), "RWA custody");
        require(deployed.votes.totalSupply() == 100 ether, "governance supply");
        require(deployed.governor.rwaEligible(), "DAO RWA eligibility");
    }

    function testA02CannotDeployOutsideBaseSepolia() public {
        VM.chainId(1);
        (bool ok,) = address(this).call(abi.encodeCall(this.deployA02AssetForChainGate, ()));
        require(!ok, "mainnet deployment accepted");
    }

    function deployA02AssetForChainGate() external returns (ArtFiA02TestAsset) {
        return new ArtFiA02TestAsset(
            ARTFI1, ARTFI1, ARTFI1, METADATA_HASH, PHYSICAL_MAPPING_HASH, METADATA_URI
        );
    }

    function testArtFi2RequiresTenPercentToPropose() public {
        Stack memory below = _deploy(9);
        (address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _marketMigrationCall(below.actions, keccak256("a02-nine-percent"));
        VM.prank(ARTFI2);
        (bool belowThreshold,) = address(below.governor)
            .call(
                abi.encodeCall(
                    below.governor.proposeWithKind,
                    (
                        targets,
                        values,
                        calls,
                        "A02 nine percent must fail",
                        ArtFiGovernor.ProposalKind.MarketMigration
                    )
                )
            );
        require(!belowThreshold, "nine percent proposed");

        Stack memory exact = _deploy(10);
        (targets, values, calls) = _marketMigrationCall(exact.actions, keccak256("a02-ten-percent"));
        VM.prank(ARTFI2);
        uint256 proposalId = exact.governor
            .proposeWithKind(
                targets,
                values,
                calls,
                "A02 ten percent may propose",
                ArtFiGovernor.ProposalKind.MarketMigration
            );
        require(proposalId != 0, "ten percent proposal missing");
    }

    function testArtFi2PassesMarketMigrationAboveFiftyPercent() public {
        Stack memory deployed = _deploy(51);
        bytes32 marketHash = keccak256("a02-test-market");
        (address[] memory targets, uint256[] memory values, bytes[] memory calls) =
            _marketMigrationCall(deployed.actions, marketHash);

        _voteQueueAndExecute(
            deployed,
            targets,
            values,
            calls,
            "A02 test market migration",
            ArtFiGovernor.ProposalKind.MarketMigration
        );
        require(deployed.actions.destinationMarketHash() == marketHash, "market action");
    }

    function testArtFi2PassesPhysicalActionAboveTwoThirds() public {
        Stack memory deployed = _deploy(67);
        address[] memory targets = new address[](1);
        targets[0] = address(deployed.actions);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            deployed.actions.requestPhysicalAction,
            (
                ArtFiDAOActions.PhysicalAction.WarehouseTransfer,
                keccak256("a02-warehouse-evidence"),
                "ipfs://a02-test/warehouse-evidence"
            )
        );

        _voteQueueAndExecute(
            deployed,
            targets,
            values,
            calls,
            "A02 test physical action",
            ArtFiGovernor.ProposalKind.PhysicalAction
        );
        require(deployed.actions.actionNonce() == 1, "physical action");
    }

    function testArtFi2PassesForcedBuyoutAboveEightyPercent() public {
        Stack memory deployed = _deploy(81);
        uint48 t0 = uint48(block.timestamp);
        ArtFiDAOActions.ForcedBuyoutTerms memory terms = ArtFiDAOActions.ForcedBuyoutTerms({
            unitPriceWei: 0.01 ether,
            t0: t0,
            observationStart: t0 - 30 days,
            pricingRule: ArtFiDAOActions.BuyoutPricingRule.ThirtyDayVolumeWeightedAverage,
            tradeCount: 1,
            evidenceHash: BUYOUT_EVIDENCE_HASH,
            evidenceURI: "ipfs://a02-test/buyout-evidence"
        });
        address[] memory targets = new address[](1);
        targets[0] = address(deployed.actions);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(deployed.actions.initiateForcedBuyout, (terms));

        _voteQueueAndExecute(
            deployed,
            targets,
            values,
            calls,
            "A02 test forced buyout",
            ArtFiGovernor.ProposalKind.ForcedBuyout
        );
        require(deployed.actions.forcedBuyoutUnitPriceWei() == 0.01 ether, "buyout action");
    }

    function _deploy(uint256 artFi2Units) private returns (Stack memory deployed) {
        VM.chainId(BASE_SEPOLIA_CHAIN_ID);
        VM.warp(40 days);

        deployed.editions = new ArtFiA02TestAsset(
            ARTFI1, ARTFI1, ARTFI1, METADATA_HASH, PHYSICAL_MAPPING_HASH, METADATA_URI
        );
        deployed.rwa = new ArtFiRWA("A02 Test RWA", "A02RWA", ARTFI1, ARTFI1, ARTFI1);

        VM.prank(ARTFI1);
        uint256 rwaTokenId = deployed.rwa.safeMint(ARTFI1, METADATA_URI);
        deployed.vault = new ArtFiVault(
            "A02 Base Sepolia Test Vault", deployed.rwa, rwaTokenId, ARTFI1, ARTFI1, ARTFI1
        );
        VM.prank(ARTFI1);
        deployed.rwa.approve(address(deployed.vault), rwaTokenId);
        VM.prank(ARTFI1);
        deployed.vault.deposit();
        VM.prank(ARTFI1);
        deployed.votes = FractionalToken(
            deployed.vault.fractionalize("A02 Test Governance", "A02TGOV", 100 ether, ARTFI1)
        );

        ArtFiA02TestPriceVerifier verifier =
            new ArtFiA02TestPriceVerifier(address(deployed.vault), BUYOUT_EVIDENCE_HASH);
        deployed.bootstrap = new ArtFiGovernanceBootstrap(deployed.vault, verifier, 1, 1, 5, 1);
        deployed.governor = deployed.bootstrap.governor();
        deployed.actions = deployed.bootstrap.actionRegistry();

        if (artFi2Units != 0) {
            uint256 editionTokenId = deployed.editions.TOKEN_ID();
            VM.prank(ARTFI1);
            deployed.editions.safeTransferFrom(ARTFI1, ARTFI2, editionTokenId, artFi2Units, "");
            VM.prank(ARTFI1);
            require(deployed.votes.transfer(ARTFI2, artFi2Units * 1 ether), "vote transfer");
            VM.prank(ARTFI2);
            deployed.votes.delegate(ARTFI2);
            VM.roll(block.number + 1);

            require(
                deployed.editions.balanceOf(ARTFI2, editionTokenId) == artFi2Units,
                "A02 buyer NFT balance"
            );
            require(
                deployed.votes.balanceOf(ARTFI2) == artFi2Units * 1 ether,
                "A02 buyer governance balance"
            );
        }
    }

    function _marketMigrationCall(ArtFiDAOActions actions, bytes32 marketHash)
        private
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory calls)
    {
        targets = new address[](1);
        targets[0] = address(actions);
        values = new uint256[](1);
        calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            actions.recordMarketMigration,
            (marketHash, keccak256("a02-market-evidence"), "ipfs://a02-test/market-evidence")
        );
    }

    function _voteQueueAndExecute(
        Stack memory deployed,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calls,
        string memory description,
        ArtFiGovernor.ProposalKind kind
    ) private {
        VM.prank(ARTFI2);
        uint256 proposalId =
            deployed.governor.proposeWithKind(targets, values, calls, description, kind);
        VM.roll(block.number + 2);
        VM.prank(ARTFI2);
        deployed.governor.castVote(proposalId, 1);
        VM.roll(block.number + 6);
        deployed.governor.queue(targets, values, calls, keccak256(bytes(description)));
        VM.warp(block.timestamp + 2);
        deployed.governor.execute(targets, values, calls, keccak256(bytes(description)));

        TimelockController timelock = deployed.bootstrap.timelock();
        require(
            timelock.hasRole(timelock.PROPOSER_ROLE(), address(deployed.governor)),
            "governor not timelock proposer"
        );
    }
}
