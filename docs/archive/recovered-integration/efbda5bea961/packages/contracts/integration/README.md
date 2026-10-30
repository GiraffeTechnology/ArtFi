# Pinned Kit integration — TEST_ONLY_NO_REAL_VALUE

This opt-in suite exercises ArtFi's application adapter against unchanged
ERC8415-Kit contracts, not a replacement standard or an Oracle implementation.

Upstream: https://github.com/GiraffeTechnology/ERC8415-Kit

Source commit: `2ccc328b07a89b678c636127c91d0962c579fe7c`

Source tree: `f3f7676227feb7de341bbc7a61d05d5b1ed87851`

The seven files in `vendor/` retain their CC0-1.0 notices and exact upstream
UTF-8 source. Do not format or edit those snapshots. SHA-256 inventory:

```text
a5d17884275af0f8c366505eaa3c07a33e372fe9bee957794e66252c601c4635  vendor/AttestationProofVerifier.sol
9d9a95d29a107840a3a70d64db215bb2a3089bba557835965a92dee899832c2f  vendor/IERC165.sol
e7e14a5fdd6940d40f847e5dcc13d5b2a9e3608b3a76885da4fdf5e6c218bb82  vendor/IProjectionSettlement.sol
7b73abacc0359aac7feb820df8cb87e045c977b4e71d8f50397002ce91015787  vendor/IRegisterProjection.sol
74901151c6426e6b302ef045ca8f16dd7c104121e44c7012418a28dacf5b9fa7  vendor/ISettlementProofVerifier.sol
48773ff1d4422c7cec46b01e030a524f4b9c67eedb205491dfc0c1b42f4fdbd1  vendor/ProjectionSettlement.sol
7b83c830e188069dbdc7c7edb45147ba55bbd744819b274f350710d25bcf4083  vendor/RegisterProjection.sol
```

From `packages/contracts`, with the repository's pinned compiler available:

```sh
FOUNDRY_TEST=integration forge test --match-contract WholeReceiptKitIntegrationTest -vv
```

Run this separately from the default contract suite; it does not replace it.
The test uses the Kit's existing EIP-191 attestation profile with a public,
synthetic test signer. It proves contract interoperability and rejection paths,
not authenticity of a production registry, real user consent, wallet integration,
Hoodi deployment, or end-to-end payment acceptance. No real asset is involved.

The application requires the Kit snapshot to equal the full ArtFi segment
authorization digest. Historical records with another snapshot meaning are not
silently promoted to payment authority. Exact deployment code hashes, expected
source/authority/profile/register and escrow bindings remain deployment inputs.
