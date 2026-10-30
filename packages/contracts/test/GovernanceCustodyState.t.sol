// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ArtFiDAOActions, IArtFiBuyoutPriceVerifier} from "../src/ArtFiDAOActions.sol";
import {ArtFiVault} from "../src/ArtFiVault.sol";

interface GovernanceCustodyVm {
    function warp(uint256 next) external;
}

/// @dev TEST_ONLY fault injection; this collection asserts no real asset authenticity.
contract GovernanceCustodyNFT is ERC721 {
    bool public unavailable;
    constructor() ERC721("Governance custody fixture", "GCF") {}

    function mint(address to) external {
        _mint(to, 1);
    }

    function forceMove(address to) external {
        _transfer(super.ownerOf(1), to, 1);
    }

    function setUnavailable(bool next) external {
        unavailable = next;
    }

    function ownerOf(uint256 id) public view override returns (address) {
        require(!unavailable, "test-only unavailable owner");
        return super.ownerOf(id);
    }
}

contract GovernanceCustodyPriceVerifier is IArtFiBuyoutPriceVerifier {
    function verifyBuyoutPrice(address, uint256, uint48, uint48, uint8, uint32, bytes32)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

contract GovernanceCustodyStateTest {
    GovernanceCustodyVm private constant VM =
        GovernanceCustodyVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    GovernanceCustodyNFT private nft;
    ArtFiVault private vault;
    ArtFiDAOActions private actions;
    TimelockController private timelock;
    bytes32 private constant EVIDENCE = keccak256("test-only-custody-evidence");

    function setUp() public {
        _deploy(true);
    }

    function _deploy(bool issue) private {
        nft = new GovernanceCustodyNFT();
        nft.mint(address(this));
        vault = new ArtFiVault(
            "Governance custody", nft, 1, address(this), address(this), address(this)
        );
        nft.approve(address(vault), 1);
        vault.deposit();
        if (issue) vault.fractionalize("Custody fractions", "CF", 100 ether, address(this));
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(2, proposers, executors, address(0));
        actions =
            new ArtFiDAOActions(vault, address(timelock), new GovernanceCustodyPriceVerifier());
    }

    function testCustodyLossBlocksMarketMigration() public {
        _assertLostCustody(0);
    }

    function testCustodyLossBlocksPhysicalAction() public {
        _assertLostCustody(1);
    }

    function testCustodyLossBlocksFailureAssessment() public {
        _assertLostCustody(2);
    }

    function testCustodyLossBlocksBuyoutInitiation() public {
        _assertLostCustody(3);
    }

    function testOwnerQueryFailureDoesNotConsumeQueuedAction() public {
        bytes memory data = _call(0);
        bytes32 salt = keccak256("owner-query");
        bytes32 id = _queue(data, salt);
        nft.setUnavailable(true);
        require(!_execute(data, salt), "unavailable custody was accepted");
        _assertUnconsumed(id);
        nft.setUnavailable(false);
        require(_execute(data, salt), "verified custody cannot resume");
        require(actions.actionNonce() == 1 && timelock.isOperationDone(id), "resume not exact once");
    }

    function testUnissuedVaultCannotRecordGovernanceAction() public {
        _deploy(false);
        bytes memory data = _call(0);
        bytes32 salt = keccak256("unissued");
        bytes32 id = _queue(data, salt);
        require(!_execute(data, salt), "unissued vault accepted governance");
        _assertUnconsumed(id);
        vault.fractionalize("Custody fractions", "CF", 100 ether, address(this));
        require(_execute(data, salt), "valid issuance cannot resume");
        require(actions.actionNonce() == 1, "resume nonce mismatch");
    }

    function testRecoveredCustodyExecutesOriginalTimelockOperationOnce() public {
        bytes memory data = _call(0);
        bytes32 salt = keccak256("same-operation");
        bytes32 id = _queue(data, salt);
        nft.forceMove(address(0xBAD));
        require(!_execute(data, salt), "missing custody accepted");
        _assertUnconsumed(id);
        nft.forceMove(address(vault));
        require(_execute(data, salt), "original queued operation cannot resume");
        require(
            actions.actionNonce() == 1 && actions.lastEvidenceHash() == EVIDENCE,
            "action not recorded"
        );
        require(timelock.isOperationDone(id), "operation not done");
        require(!_execute(data, salt) && actions.actionNonce() == 1, "completed action replayed");
    }

    function testUnauthorizedCallerRemainsRejectedBeforeCustodyQuery() public {
        nft.setUnavailable(true);
        (bool ok, bytes memory reason) = address(actions).call(_call(0));
        require(!ok && reason.length >= 4, "unauthorized call accepted");
        bytes4 selector;
        assembly ("memory-safe") { selector := mload(add(reason, 0x20)) }
        require(
            selector == ArtFiDAOActions.UnauthorizedExecutor.selector, "executor boundary reordered"
        );
        require(actions.actionNonce() == 0, "unauthorized call mutated action");
    }

    function _assertLostCustody(uint8 kind) private {
        bytes memory data = _call(kind);
        bytes32 salt = keccak256(abi.encode("lost", kind));
        bytes32 id = _queue(data, salt);
        nft.forceMove(address(0xBAD));
        require(!_execute(data, salt), "lost custody accepted through direct timelock");
        _assertUnconsumed(id);
        require(
            actions.destinationMarketHash() == bytes32(0)
                && actions.forcedBuyoutUnitPriceWei() == 0,
            "unbacked action mutated ledger"
        );
    }

    function _assertUnconsumed(bytes32 id) private view {
        require(
            actions.actionNonce() == 0 && actions.lastEvidenceHash() == bytes32(0),
            "failed action consumed ledger"
        );
        require(
            timelock.isOperationReady(id) && !timelock.isOperationDone(id),
            "failed action consumed queue"
        );
    }

    function _queue(bytes memory data, bytes32 salt) private returns (bytes32 id) {
        timelock.schedule(address(actions), 0, data, bytes32(0), salt, 2);
        id = timelock.hashOperation(address(actions), 0, data, bytes32(0), salt);
        VM.warp(block.timestamp + 3);
    }

    function _execute(bytes memory data, bytes32 salt) private returns (bool ok) {
        (ok,) = address(timelock)
            .call(abi.encodeCall(timelock.execute, (address(actions), 0, data, bytes32(0), salt)));
    }

    function _call(uint8 kind) private view returns (bytes memory) {
        if (kind == 0) {
            return abi.encodeCall(
                actions.recordMarketMigration, (keccak256("market"), EVIDENCE, "ipfs://test-only")
            );
        }
        if (kind == 1) {
            return abi.encodeCall(
                actions.requestPhysicalAction,
                (ArtFiDAOActions.PhysicalAction.WarehouseTransfer, EVIDENCE, "ipfs://test-only")
            );
        }
        if (kind == 2) {
            return abi.encodeCall(
                actions.recordSharedFailureAssessment,
                (10 ether, uint48(block.timestamp + 30 days), EVIDENCE, "ipfs://test-only")
            );
        }
        ArtFiDAOActions.ForcedBuyoutTerms memory terms = ArtFiDAOActions.ForcedBuyoutTerms({
            unitPriceWei: 1 ether,
            t0: uint48(block.timestamp),
            observationStart: 0,
            pricingRule: ArtFiDAOActions.BuyoutPricingRule.LastTenActualTrades,
            tradeCount: 10,
            evidenceHash: EVIDENCE,
            evidenceURI: "ipfs://test-only"
        });
        return abi.encodeCall(actions.initiateForcedBuyout, (terms));
    }

    function onERC721Received(address, address, uint256, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC721Received.selector;
    }
}
