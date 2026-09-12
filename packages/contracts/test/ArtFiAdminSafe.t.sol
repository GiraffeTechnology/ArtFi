// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {ArtFiAdminSafe} from "../src/ArtFiAdminSafe.sol";
import {ArtFiMarket} from "../src/ArtFiMarket.sol";

interface AdminSafeVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
}

contract AdminSafeTarget {
    bool public paused;
    uint256 public executionCount;

    function setPaused(bool paused_) external {
        paused = paused_;
        ++executionCount;
    }

    function fail() external pure {
        revert("target failure");
    }
}

contract AdminSafeAssetToken is ERC20 {
    constructor() ERC20("Admin Safe Test Asset", "ASTA") {}

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }
}

contract ArtFiAdminSafeTest {
    AdminSafeVm private constant VM =
        AdminSafeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER_B = address(0xB0B);
    address private constant OWNER_C = address(0xCAFE);
    address private constant OUTSIDER = address(0xBAD);
    uint64 private constant DELAY = 2 days;

    ArtFiAdminSafe private safe;
    AdminSafeTarget private target;

    function setUp() public {
        address[] memory owners_ = new address[](3);
        owners_[0] = address(this);
        owners_[1] = OWNER_B;
        owners_[2] = OWNER_C;
        safe = new ArtFiAdminSafe(owners_, 2, DELAY);
        target = new AdminSafeTarget();
    }

    function testConstructorRejectsSingleOwnerThresholdOneAndDuplicates() public {
        address[] memory oneOwner = new address[](1);
        oneOwner[0] = address(this);
        (bool singleOwner,) =
            address(this).call(abi.encodeCall(this.deploySafe, (oneOwner, 1, DELAY)));
        require(!singleOwner, "single owner safe created");

        address[] memory duplicates = new address[](2);
        duplicates[0] = address(this);
        duplicates[1] = address(this);
        (bool duplicateOwners,) =
            address(this).call(abi.encodeCall(this.deploySafe, (duplicates, 2, DELAY)));
        require(!duplicateOwners, "duplicate owner safe created");

        address[] memory twoOwners = new address[](2);
        twoOwners[0] = address(this);
        twoOwners[1] = OWNER_B;
        (bool zeroDelay,) = address(this).call(abi.encodeCall(this.deploySafe, (twoOwners, 2, 0)));
        require(!zeroDelay, "zero delay safe created");
    }

    function testSingleOwnerCannotExecuteAndNonOwnerCannotConfirm() public {
        uint256 transactionId = _submitPause(keccak256("single-owner"));
        (bool singleExecuted,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!singleExecuted, "single owner executed");

        VM.prank(OUTSIDER);
        (bool outsiderConfirmed,) =
            address(safe).call(abi.encodeCall(safe.confirm, (transactionId)));
        require(!outsiderConfirmed, "outsider confirmed");
        require(!target.paused(), "target changed without threshold");
    }

    function testThresholdAndTimelockAreBothRequired() public {
        uint256 transactionId = _submitPause(keccak256("threshold-delay"));
        VM.prank(OWNER_B);
        safe.confirm(transactionId);

        (bool early,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!early, "executed before timelock");
        VM.warp(block.timestamp + DELAY);
        VM.prank(OWNER_C);
        safe.execute(transactionId);
        require(target.paused(), "approved transaction not executed");
        require(target.executionCount() == 1, "unexpected execution count");
    }

    function testPrivilegedPauseRoleHasNoSingleOwnerExecutionPath() public {
        ArtFiMarket governedMarket = new ArtFiMarket(address(safe), address(safe), address(safe));
        require(
            governedMarket.hasRole(governedMarket.DEFAULT_ADMIN_ROLE(), address(safe)),
            "safe missing admin role"
        );
        require(
            governedMarket.hasRole(governedMarket.PAUSER_ROLE(), address(safe)),
            "safe missing pauser role"
        );
        require(
            governedMarket.hasRole(governedMarket.TOKEN_MANAGER_ROLE(), address(safe)),
            "safe missing token manager role"
        );
        require(
            !governedMarket.hasRole(governedMarket.DEFAULT_ADMIN_ROLE(), address(this))
                && !governedMarket.hasRole(governedMarket.PAUSER_ROLE(), address(this))
                && !governedMarket.hasRole(governedMarket.TOKEN_MANAGER_ROLE(), address(this)),
            "owner retained privileged role"
        );
        (bool directPause,) = address(governedMarket).call(abi.encodeCall(governedMarket.pause, ()));
        require(!directPause, "single owner paused directly");
        (bool directTokenPermission,) = address(governedMarket)
            .call(abi.encodeCall(governedMarket.setTokenPermission, (address(target), true, true)));
        require(!directTokenPermission, "single owner changed token permissions");

        uint256 transactionId = safe.submit(
            keccak256("governed-pause"),
            address(governedMarket),
            0,
            abi.encodeCall(governedMarket.pause, ())
        );
        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        (bool early,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!early, "safe bypassed pause timelock");
        VM.warp(block.timestamp + DELAY);
        safe.execute(transactionId);
        require(governedMarket.paused(), "threshold safe did not pause market");
    }

    function testNoDelegatecallExecutionSurfaceExists() public {
        (bool ok,) = address(safe)
            .call(
                abi.encodeWithSignature(
                    "executeDelegatecall(uint256,address,bytes)",
                    1,
                    address(target),
                    abi.encodeCall(target.setPaused, (true))
                )
            );
        require(!ok, "delegatecall execution surface exists");
        require(!target.paused(), "delegatecall probe changed target state");
    }

    function testSingleOwnerCannotTransferSafeCustodiedAsset() public {
        AdminSafeAssetToken asset = new AdminSafeAssetToken();
        asset.mint(address(safe), 100 ether);
        uint256 transactionId = safe.submit(
            keccak256("custodied-asset-transfer"),
            address(asset),
            0,
            abi.encodeCall(asset.transfer, (OUTSIDER, 40 ether))
        );

        (bool singleOwnerExecuted,) =
            address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!singleOwnerExecuted, "single owner transferred safe asset");
        require(asset.balanceOf(address(safe)) == 100 ether, "safe balance changed early");
        require(asset.balanceOf(OUTSIDER) == 0, "recipient received asset early");

        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        VM.warp(block.timestamp + DELAY);
        safe.execute(transactionId);
        require(asset.balanceOf(address(safe)) == 60 ether, "safe balance not debited");
        require(asset.balanceOf(OUTSIDER) == 40 ether, "recipient balance not credited");
    }

    function testRevocationBelowThresholdRestartsFullDelay() public {
        uint256 transactionId = _submitPause(keccak256("revoke"));
        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        ArtFiAdminSafe.Transaction memory confirmed = safe.transaction(transactionId);
        uint256 firstReadyAt = confirmed.readyAt;

        VM.prank(OWNER_B);
        safe.revoke(transactionId);
        VM.warp(firstReadyAt);
        (bool revokedExecuted,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!revokedExecuted, "revoked confirmation executed");

        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        ArtFiAdminSafe.Transaction memory reconfirmed = safe.transaction(transactionId);
        require(reconfirmed.readyAt == block.timestamp + DELAY, "delay did not restart");
        require(reconfirmed.readyAt > firstReadyAt, "old ready time reused");
    }

    function testTimelockOverflowFailsClosedWithoutRecordingConfirmation() public {
        uint256 transactionId = _submitPause(keccak256("timelock-overflow"));
        VM.warp(type(uint64).max);
        VM.prank(OWNER_B);
        (bool confirmed,) = address(safe).call(abi.encodeCall(safe.confirm, (transactionId)));
        require(!confirmed, "overflowing timelock accepted");

        ArtFiAdminSafe.Transaction memory stored = safe.transaction(transactionId);
        require(stored.confirmations == 1, "failed confirmation changed count");
        require(stored.readyAt == 0, "failed confirmation scheduled transaction");
        require(!safe.confirmedBy(transactionId, OWNER_B), "failed confirmation persisted owner");
    }

    function testRequestReplayIsIdempotentAndConflictingCallIsRejected() public {
        bytes32 requestId = keccak256("replay");
        bytes memory data = abi.encodeCall(target.setPaused, (true));
        uint256 first = safe.submit(requestId, address(target), 0, data);
        uint256 replay = safe.submit(requestId, address(target), 0, data);
        require(first == replay, "replay changed transaction id");
        ArtFiAdminSafe.Transaction memory stored = safe.transaction(first);
        require(stored.confirmations == 1, "replay added confirmation");

        (bool conflict,) = address(safe)
            .call(
                abi.encodeCall(
                    safe.submit,
                    (requestId, address(target), 0, abi.encodeCall(target.setPaused, (false)))
                )
            );
        require(!conflict, "conflicting request accepted");
    }

    function testTargetCallFailureRollsBackExecutedState() public {
        uint256 transactionId = safe.submit(
            keccak256("target-failure"), address(target), 0, abi.encodeCall(target.fail, ())
        );
        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        VM.warp(block.timestamp + DELAY);
        (bool executed,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!executed, "failed target reported success");
        ArtFiAdminSafe.Transaction memory stored = safe.transaction(transactionId);
        require(!stored.executed, "failed target consumed transaction");
    }

    function testFuzzCannotExecuteBeforeDelay(uint32 elapsed) public {
        uint256 transactionId = _submitPause(keccak256(abi.encode("fuzz-delay", elapsed)));
        VM.prank(OWNER_B);
        safe.confirm(transactionId);
        uint256 boundedElapsed = uint256(elapsed) % DELAY;
        VM.warp(block.timestamp + boundedElapsed);
        (bool executed,) = address(safe).call(abi.encodeCall(safe.execute, (transactionId)));
        require(!executed, "fuzz execution bypassed delay");
    }

    function deploySafe(address[] memory owners_, uint256 threshold_, uint64 delay_)
        external
        returns (ArtFiAdminSafe deployed)
    {
        deployed = new ArtFiAdminSafe(owners_, threshold_, delay_);
    }

    function _submitPause(bytes32 requestId) private returns (uint256 transactionId) {
        transactionId =
            safe.submit(requestId, address(target), 0, abi.encodeCall(target.setPaused, (true)));
    }
}
