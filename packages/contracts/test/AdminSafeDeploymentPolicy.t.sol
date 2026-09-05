// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiAdminSafe} from "../src/ArtFiAdminSafe.sol";
import {AdminSafeDeploymentPolicy} from "../src/AdminSafeDeploymentPolicy.sol";

/// @dev The policy is a library, so it is exercised through a harness that exposes it.
contract AdminSafePolicyHarness {
    function validate(address candidate, bytes32 expectedCodehash) external view {
        AdminSafeDeploymentPolicy.validate(candidate, expectedCodehash);
    }
}

/// @notice Answers the configuration interface but was never constrained by
///         `ArtFiAdminSafe`'s constructor, so it can report a threshold of one or a
///         zero delay. This is the shape the policy exists to reject: a contract that
///         looks like a safe from the outside.
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

/// @notice Answers nothing. Standing in for an unrelated contract at the configured address.
contract SilentContract {
    function unrelated() external pure returns (uint256) {
        return 1;
    }
}

/// @notice Policy-level coverage only.
/// @dev The tests that drive the policy through `DeployStage2`, `DeployStage3` and
///      `DeployCharityEditions` are deliberately absent here: those scripts do not bind
///      privileged roles to the safe on this branch, so such tests would assert behaviour
///      that does not exist yet. They belong with the deployment binding, together with
///      the frontend paths that binding breaks.
contract AdminSafeDeploymentPolicyTest {
    address private constant OWNER_B = address(0xB0B);
    uint64 private constant DELAY = 1 days;

    AdminSafePolicyHarness private policy;
    ArtFiAdminSafe private safe;

    function setUp() public {
        policy = new AdminSafePolicyHarness();
        safe = _newSafe(2, DELAY);
    }

    function _owners() private view returns (address[] memory list) {
        list = new address[](2);
        list[0] = address(this);
        list[1] = OWNER_B;
    }

    function _newSafe(uint256 threshold_, uint64 delay_) private returns (ArtFiAdminSafe) {
        return new ArtFiAdminSafe(_owners(), threshold_, delay_);
    }

    function deploySafe(address[] memory owners_, uint256 threshold_, uint64 delay_)
        external
        returns (ArtFiAdminSafe)
    {
        return new ArtFiAdminSafe(owners_, threshold_, delay_);
    }

    function _rejects(address candidate, bytes32 codehash) private view returns (bool) {
        try policy.validate(candidate, codehash) {
            return false;
        } catch {
            return true;
        }
    }

    /// A single-signer safe is not a safe, and a zero delay removes the timelock, so the
    /// constructor refuses both. The policy must not be the only thing standing between
    /// a deployment and a one-of-n administrator.
    function testConstructorRejectsThresholdOneAndZeroDelay() public {
        address[] memory owners_ = _owners();
        (bool thresholdOne,) =
            address(this).call(abi.encodeCall(this.deploySafe, (owners_, 1, DELAY)));
        require(!thresholdOne, "threshold-one safe deployed");
        (bool zeroDelay,) = address(this).call(abi.encodeCall(this.deploySafe, (owners_, 2, 0)));
        require(!zeroDelay, "zero-delay safe deployed");
    }

    /// An externally owned account has no code, so it can never be the safe.
    function testRejectsAddressWithoutCode() public view {
        require(_rejects(OWNER_B, bytes32(0)), "EOA accepted");
    }

    /// Having code is not enough: the candidate must answer the configuration interface.
    function testRejectsContractWithoutConfigurationInterface() public {
        SilentContract silent = new SilentContract();
        require(_rejects(address(silent), address(silent).codehash), "silent contract accepted");
    }

    /// The codehash pin is what stops a lookalike from being accepted. Validating a real
    /// safe against a different codehash must fail, or the pin is decorative.
    function testRejectsRealSafeUnderWrongCodehash() public {
        SilentContract other = new SilentContract();
        require(_rejects(address(safe), address(other).codehash), "wrong codehash accepted");
    }

    /// A zero expected codehash must not be treated as "no pin requested".
    function testRejectsZeroExpectedCodehash() public view {
        require(_rejects(address(safe), bytes32(0)), "zero codehash accepted");
    }

    /// Configuration is re-checked at validation time, independently of the constructor,
    /// so a contract that answers the interface with a threshold of one is still rejected.
    function testRejectsMalformedSafeWithThresholdOne() public {
        MalformedAdminSafe malformed = new MalformedAdminSafe(_owners(), 1, DELAY);
        require(
            _rejects(address(malformed), address(malformed).codehash),
            "threshold-one configuration accepted"
        );
    }

    function testRejectsMalformedSafeWithZeroDelay() public {
        MalformedAdminSafe malformed = new MalformedAdminSafe(_owners(), 2, 0);
        require(
            _rejects(address(malformed), address(malformed).codehash),
            "zero-delay configuration accepted"
        );
    }

    /// Duplicate owners inflate the apparent signer count without adding a signer.
    function testRejectsDuplicateOwners() public {
        address[] memory duplicated = new address[](2);
        duplicated[0] = OWNER_B;
        duplicated[1] = OWNER_B;
        MalformedAdminSafe malformed = new MalformedAdminSafe(duplicated, 2, DELAY);
        require(
            _rejects(address(malformed), address(malformed).codehash), "duplicate owners accepted"
        );
    }

    /// A guard that rejects everything blocks legitimate deployment, so the genuine safe
    /// under its own codehash must pass.
    function testAcceptsGenuineSafe() public view {
        require(!_rejects(address(safe), address(safe).codehash), "genuine safe rejected");
    }
}
