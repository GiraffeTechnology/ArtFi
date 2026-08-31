// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiAdminSafe} from "../src/ArtFiAdminSafe.sol";
import {AdminSafeDeploymentPolicy} from "../src/AdminSafeDeploymentPolicy.sol";
import {ArtFiCharityEditions} from "../src/ArtFiCharityEditions.sol";
import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {RWARegistry} from "../src/RWARegistry.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {DeployCharityEditions} from "../script/DeployCharityEditions.s.sol";
import {DeployStage2} from "../script/DeployStage2.s.sol";
import {DeployStage3} from "../script/DeployStage3.s.sol";

interface AdminSafeDeploymentTestVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract AdminSafePolicyHarness {
    function validate(address candidate, bytes32 expectedCodehash) external view {
        AdminSafeDeploymentPolicy.validate(candidate, expectedCodehash);
    }
}

contract MalformedAdminSafe {
    address[] private _owners;
    uint256 public immutable threshold;
    uint64 public immutable delaySeconds;

    constructor(address[] memory owners_, uint256 threshold_, uint64 delaySeconds_) {
        _owners = owners_;
        threshold = threshold_;
        delaySeconds = delaySeconds_;
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }
}

contract Stage2Harness is DeployStage2 {
    function deploy(address adminSafe) external returns (ArtFiRWA nft, RWARegistry registry) {
        return _deploy(adminSafe, address(this));
    }
}

contract Stage3Harness is DeployStage3 {
    function deploy(address adminSafe) external returns (VaultFactory factory) {
        return _deploy(adminSafe);
    }
}

contract CharityHarness is DeployCharityEditions {
    function deploy(address adminSafe) external returns (ArtFiCharityEditions editions) {
        return _deploy(adminSafe);
    }
}

contract AdminSafeDeploymentPolicyTest {
    AdminSafeDeploymentTestVm private constant VM =
        AdminSafeDeploymentTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER_B = address(0xB0B);
    uint64 private constant DELAY = 1 days;

    AdminSafePolicyHarness private policy;
    ArtFiAdminSafe private safe;
    Stage2Harness private stage2;
    Stage3Harness private stage3;
    CharityHarness private charity;

    function setUp() public {
        policy = new AdminSafePolicyHarness();
        safe = _newSafe(2, DELAY);
        stage2 = new Stage2Harness();
        stage3 = new Stage3Harness();
        charity = new CharityHarness();
    }

    function testDeployAdminSafeRejectsThresholdOneAndZeroDelay() public {
        address[] memory owners_ = _owners();
        (bool thresholdOne,) =
            address(this).call(abi.encodeCall(this.deploySafe, (owners_, 1, DELAY)));
        require(!thresholdOne, "threshold-one safe deployed");
        (bool zeroDelay,) = address(this).call(abi.encodeCall(this.deploySafe, (owners_, 2, 0)));
        require(!zeroDelay, "zero-delay safe deployed");
    }

    function testStage2RejectsEOAAdminSafe() public {
        (bool ok,) = address(stage2).call(abi.encodeCall(stage2.deploy, (OWNER_B)));
        require(!ok, "EOA admin safe accepted");
    }

    function testStage3RejectsNoCodeAdminSafe() public {
        (bool ok,) = address(stage3).call(abi.encodeCall(stage3.deploy, (address(0xD00D))));
        require(!ok, "no-code admin safe accepted");
    }

    function testRejectsMalformedSafeWithThresholdOne() public {
        MalformedAdminSafe malformed = new MalformedAdminSafe(_owners(), 1, DELAY);
        (bool ok,) = address(policy)
            .call(
                abi.encodeCall(policy.validate, (address(malformed), address(malformed).codehash))
            );
        require(!ok, "threshold-one configuration accepted");
    }

    function testRejectsMalformedSafeWithZeroDelay() public {
        MalformedAdminSafe malformed = new MalformedAdminSafe(_owners(), 2, 0);
        (bool ok,) = address(policy)
            .call(
                abi.encodeCall(policy.validate, (address(malformed), address(malformed).codehash))
            );
        require(!ok, "zero-delay configuration accepted");
    }

    function testAllStagesUseSameAdminSafe() public {
        (ArtFiRWA nft, RWARegistry registry) = stage2.deploy(address(safe));
        VaultFactory factory = stage3.deploy(address(safe));
        ArtFiCharityEditions editions = charity.deploy(address(safe));

        require(nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), address(safe)), "NFT admin differs");
        require(
            registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), address(safe)), "registry admin differs"
        );
        require(
            factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), address(safe)), "factory admin differs"
        );
        require(
            editions.hasRole(editions.DEFAULT_ADMIN_ROLE(), address(safe)), "charity admin differs"
        );
    }

    function testStage2LeavesNoDeployerAdminPauserOrMinter() public {
        (ArtFiRWA nft, RWARegistry registry) = stage2.deploy(address(safe));
        require(!nft.hasRole(nft.DEFAULT_ADMIN_ROLE(), address(stage2)), "deployer kept NFT admin");
        require(!nft.hasRole(nft.PAUSER_ROLE(), address(stage2)), "deployer kept NFT pauser");
        require(!nft.hasRole(nft.MINTER_ROLE(), address(stage2)), "deployer kept NFT minter");
        require(nft.hasRole(nft.MINTER_ROLE(), address(registry)), "registry missing NFT minter");
        require(
            registry.hasRole(registry.REGISTRAR_ROLE(), address(safe)), "safe missing registrar"
        );
        require(
            registry.hasRole(registry.PAUSER_ROLE(), address(safe)), "safe missing registry pauser"
        );
    }

    function testStage3OnlySafeHasAdminCreatorPauser() public {
        VaultFactory factory = stage3.deploy(address(safe));
        require(factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), address(safe)), "safe missing admin");
        require(factory.hasRole(factory.CREATOR_ROLE(), address(safe)), "safe missing creator");
        require(factory.hasRole(factory.PAUSER_ROLE(), address(safe)), "safe missing pauser");
        require(!factory.hasRole(factory.DEFAULT_ADMIN_ROLE(), address(this)), "owner has admin");
        require(!factory.hasRole(factory.CREATOR_ROLE(), address(this)), "owner has creator");
        require(!factory.hasRole(factory.PAUSER_ROLE(), address(this)), "owner has pauser");
    }

    function testCharityOnlySafeHasAdminCreatorRecorderPauser() public {
        ArtFiCharityEditions editions = charity.deploy(address(safe));
        require(
            editions.hasRole(editions.DEFAULT_ADMIN_ROLE(), address(safe)), "safe missing admin"
        );
        require(
            editions.hasRole(editions.SERIES_CREATOR_ROLE(), address(safe)), "safe missing creator"
        );
        require(
            editions.hasRole(editions.DONATION_RECORDER_ROLE(), address(safe)),
            "safe missing donation recorder"
        );
        require(editions.hasRole(editions.PAUSER_ROLE(), address(safe)), "safe missing pauser");
        require(!editions.hasRole(editions.DEFAULT_ADMIN_ROLE(), address(this)), "owner has admin");
        require(
            !editions.hasRole(editions.SERIES_CREATOR_ROLE(), address(this)), "owner has creator"
        );
        require(
            !editions.hasRole(editions.DONATION_RECORDER_ROLE(), address(this)),
            "owner has donation recorder"
        );
        require(!editions.hasRole(editions.PAUSER_ROLE(), address(this)), "owner has pauser");
    }

    function testSafeThresholdAndTimelockRequiredForPause() public {
        VaultFactory factory = stage3.deploy(address(safe));
        uint256 transactionId = safe.submit(
            keccak256("pause-stage3-factory"),
            address(factory),
            0,
            abi.encodeCall(factory.pause, ())
        );
        (bool singleOwner,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!singleOwner, "single owner paused factory");
        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        (bool beforeDelay,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!beforeDelay, "timelock bypassed");
        VM.warp(block.timestamp + DELAY);
        safe.execute(transactionId);
        require(factory.paused(), "safe did not pause factory");
    }

    function deploySafe(address[] memory owners_, uint256 threshold_, uint64 delaySeconds_)
        external
        returns (ArtFiAdminSafe)
    {
        return new ArtFiAdminSafe(owners_, threshold_, delaySeconds_);
    }

    function _newSafe(uint256 threshold_, uint64 delaySeconds_) private returns (ArtFiAdminSafe) {
        return new ArtFiAdminSafe(_owners(), threshold_, delaySeconds_);
    }

    function _owners() private view returns (address[] memory owners_) {
        owners_ = new address[](2);
        owners_[0] = address(this);
        owners_[1] = OWNER_B;
    }
}
