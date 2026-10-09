// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArtFiRWA} from "../src/ArtFiRWA.sol";
import {RWARegistry} from "../src/RWARegistry.sol";

interface Vm {
    function envAddress(string calldata name) external view returns (address value);
    function envBool(string calldata name) external view returns (bool value);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Hoodi-only deployment script. The signing method is supplied by forge at runtime;
///         this source never reads or stores a private key.
contract DeployStage2 {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant HOODI_CHAIN_ID = 560_048;

    error UnsupportedChain(uint256 chainId);
    error ZeroAddress();
    error IndependentSourceAuthorityRequired();

    function run() external returns (ArtFiRWA nft, RWARegistry registry) {
        if (block.chainid != HOODI_CHAIN_ID) revert UnsupportedChain(block.chainid);

        address deployer = VM.envAddress("DEPLOYER_ADDRESS");
        address admin = VM.envAddress("ARTFI_ADMIN");
        address registrar = VM.envAddress("ARTFI_REGISTRAR");
        address pauser = VM.envAddress("ARTFI_PAUSER");
        address sourceAuthority = VM.envAddress("ARTFI_SOURCE_AUTHORITY");
        bool testOnly = VM.envBool("ARTFI_RWA_TEST_ONLY");
        if (
            sourceAuthority == address(0) || sourceAuthority == admin
                || sourceAuthority == registrar
        ) revert IndependentSourceAuthorityRequired();
        if (
            deployer == address(0) || admin == address(0) || registrar == address(0)
                || pauser == address(0)
        ) revert ZeroAddress();

        VM.startBroadcast();

        nft = new ArtFiRWA(
            testOnly ? "ArtFi TESTNET - NO REAL-WORLD VALUE - NO LEGAL EFFECT" : "ArtFi RWA",
            "ARWA",
            deployer,
            deployer,
            deployer
        );
        registry = new RWARegistry(nft, admin, registrar, pauser, sourceAuthority, testOnly);
        nft.bindMintRegistry(address(registry));

        nft.grantRole(nft.MINTER_ROLE(), address(registry));
        nft.revokeRole(nft.MINTER_ROLE(), deployer);

        if (pauser != deployer) {
            nft.grantRole(nft.PAUSER_ROLE(), pauser);
            nft.revokeRole(nft.PAUSER_ROLE(), deployer);
        }
        if (admin != deployer) {
            nft.grantRole(nft.DEFAULT_ADMIN_ROLE(), admin);
            nft.renounceRole(nft.DEFAULT_ADMIN_ROLE(), deployer);
        }

        VM.stopBroadcast();
    }
}
