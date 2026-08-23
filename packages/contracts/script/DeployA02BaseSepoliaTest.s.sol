// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiGovernanceBootstrap} from "../src/ArtFiGovernanceBootstrap.sol";
import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";
import {FractionalToken} from "../src/FractionalToken.sol";
import {RWARegistry} from "../src/RWARegistry.sol";
import {ArtFiA02TestAsset} from "../src/testonly/ArtFiA02TestAsset.sol";
import {ArtFiA02TestPriceVerifier} from "../src/testonly/ArtFiA02TestPriceVerifier.sol";

interface VmA02BaseSepolia {
    function envAddress(string calldata name) external view returns (address value);
    function envBytes32(string calldata name) external view returns (bytes32 value);
    function envString(string calldata name) external view returns (string memory value);
    function envUint(string calldata name) external view returns (uint256 value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys the isolated UNIT-A02 RWA/DAO exercise on Base Sepolia only.
/// @dev Signing is supplied externally. The source never reads or stores a private key.
contract DeployA02BaseSepoliaTest {
    VmA02BaseSepolia private constant VM =
        VmA02BaseSepolia(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BASE_SEPOLIA_CHAIN_ID = 84_532;
    address private constant ARTFI1 = 0x75F6e1BAc9bF07a54FECc416ef76327BbD2c3089;
    bytes32 private constant A02_REQUEST_ID = keccak256("ARTFI/BASE-SEPOLIA/A02/RWA-DAO/V1");

    struct Deployment {
        ArtFiA02TestAsset editions;
        ArtFiRWA rwa;
        RWARegistry registry;
        ArtFiVault vault;
        FractionalToken governanceToken;
        ArtFiA02TestPriceVerifier priceVerifier;
        ArtFiGovernanceBootstrap governance;
    }

    error BaseSepoliaOnly(uint256 chainId);
    error InvalidConfiguration();
    error OfficialWalletOnly(address supplied);

    function run() external returns (Deployment memory deployed) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert BaseSepoliaOnly(block.chainid);

        address deployer = VM.envAddress("DEPLOYER_ADDRESS");
        bytes32 metadataHash = VM.envBytes32("ARTFI_A02_TEST_METADATA_SHA256");
        bytes32 physicalMappingHash =
            VM.envBytes32("ARTFI_A02_TEST_PHYSICAL_MAPPING_EVIDENCE_SHA256");
        bytes32 buyoutEvidenceHash = VM.envBytes32("ARTFI_A02_TEST_BUYOUT_EVIDENCE_SHA256");
        string memory metadataURI = VM.envString("ARTFI_A02_TEST_METADATA_URI");
        uint256 timelockDelay = VM.envUint("ARTFI_TIMELOCK_DELAY_SECONDS");
        uint256 votingDelay = VM.envUint("ARTFI_VOTING_DELAY_BLOCKS");
        uint256 votingPeriod = VM.envUint("ARTFI_VOTING_PERIOD_BLOCKS");
        uint256 quorumPercent = VM.envUint("ARTFI_QUORUM_PERCENT");

        if (deployer != ARTFI1) revert OfficialWalletOnly(deployer);
        if (
            metadataHash == bytes32(0) || physicalMappingHash == bytes32(0)
                || buyoutEvidenceHash == bytes32(0) || bytes(metadataURI).length == 0
                || votingDelay > type(uint48).max || votingPeriod == 0
                || votingPeriod > type(uint32).max || quorumPercent == 0 || quorumPercent > 100
        ) revert InvalidConfiguration();

        VM.startBroadcast();

        deployed.editions = new ArtFiA02TestAsset(
            ARTFI1, ARTFI1, ARTFI1, metadataHash, physicalMappingHash, metadataURI
        );

        deployed.rwa = new ArtFiRWA("ArtFi A02 Test RWA", "A02TRWA", ARTFI1, ARTFI1, ARTFI1);
        deployed.registry = new RWARegistry(deployed.rwa, ARTFI1, ARTFI1, ARTFI1);
        deployed.rwa.grantRole(deployed.rwa.MINTER_ROLE(), address(deployed.registry));
        deployed.rwa.revokeRole(deployed.rwa.MINTER_ROLE(), ARTFI1);

        uint256 rwaTokenId =
            deployed.registry.createAsset(A02_REQUEST_ID, ARTFI1, metadataURI, metadataHash);
        deployed.vault = new ArtFiVault(
            "UNIT-A02 Base Sepolia Test Vault", deployed.rwa, rwaTokenId, ARTFI1, ARTFI1, ARTFI1
        );
        deployed.rwa.approve(address(deployed.vault), rwaTokenId);
        deployed.vault.deposit();
        deployed.governanceToken = FractionalToken(
            deployed.vault.fractionalize("UNIT-A02 Test Governance", "A02TGOV", 100 ether, ARTFI1)
        );

        deployed.priceVerifier =
            new ArtFiA02TestPriceVerifier(address(deployed.vault), buyoutEvidenceHash);
        deployed.governance = new ArtFiGovernanceBootstrap(
            deployed.vault,
            deployed.priceVerifier,
            timelockDelay,
            uint48(votingDelay),
            uint32(votingPeriod),
            quorumPercent
        );

        VM.stopBroadcast();
    }
}
