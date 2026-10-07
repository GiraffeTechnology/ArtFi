import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  custom,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import {
  artFiVaultAbi,
  erc721VaultApprovalAbi,
  rwaRegistryAbi,
  vaultFactoryAbi,
} from "../lib/contracts";
import {
  isMintIntent,
  recoverMintedAsset,
  type MintIntent,
} from "../lib/rwa-mint-recovery";
import {
  isVaultSetup,
  recoverCreatedVault,
  type VaultSetup,
} from "../lib/vault-setup";
import {
  createSetupChainFixture,
  setupAddresses as addresses,
  setupMetadataHash,
  setupMetadataUri,
  setupRequestIds,
} from "./setup-chain-fixture";

function fixture() {
  const chain = createSetupChainFixture();
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        const response = chain.rpc({ id: 1, method, params });
        if (response.error) throw new Error(response.error.message);
        return response.result;
      },
    }),
  });
  return { chain, client };
}

const mintIntent: MintIntent = {
  intentId: "TEST-ONLY-mint-intent",
  requestId: setupRequestIds.mint,
  recipient: addresses.wallet,
  registryAddress: addresses.registry,
  chainId: 560048,
  metadataUri: setupMetadataUri,
  metadataSha256: setupMetadataHash,
  status: "prepared",
};
const configuration = {
  collectionAddress: addresses.collection,
  tokenId: "1",
  vaultName: "TEST_ONLY Recovery DAO",
  adminAddress: addresses.wallet,
  pauserAddress: addresses.wallet,
  fractionalizerAddress: addresses.wallet,
  tokenName: "TEST_ONLY Fractions",
  tokenSymbol: "TEST",
  tokenSupply: String(100n * 10n ** 18n),
  recipient: addresses.wallet,
};
const vaultSetup: VaultSetup = {
  chainId: 560048,
  walletAddress: addresses.wallet,
  factoryAddress: addresses.factory,
  idempotencyKey: "TEST-ONLY-idempotency-key",
  configuration,
  intent: {
    intentId: "TEST-ONLY-vault-intent",
    requestId: setupRequestIds.vault,
    factoryAddress: addresses.factory,
    chainId: 560048,
    ...configuration,
  },
  stage: "configure",
};

describe("TEST_ONLY setup RPC fixture against the real recovery helpers", () => {
  it("recovers a no-event mint replay through the exact committed registry request", async () => {
    const { chain, client } = fixture();
    chain.state.noCreationEvents = true;
    expect(isMintIntent(mintIntent)).toBe(true);
    const hash = chain.submit({
      to: addresses.registry,
      data: encodeFunctionData({
        abi: rwaRegistryAbi,
        functionName: "createAsset",
        args: [
          setupRequestIds.mint,
          addresses.wallet,
          setupMetadataUri,
          setupMetadataHash,
        ],
      }),
    });
    expect((await client.getTransactionReceipt({ hash })).logs).toEqual([]);
    await expect(
      recoverMintedAsset(client, mintIntent, addresses.wallet, () => {}),
    ).resolves.toEqual({
      chainId: 560048,
      collectionAddress: addresses.collection,
      tokenId: "1",
    });
    await expect(
      recoverMintedAsset(
        client,
        { ...mintIntent, metadataUri: "ipfs://TEST_ONLY-wrong-commitment" },
        addresses.wallet,
        () => {},
      ),
    ).rejects.toThrow("does not match the saved request");
    expect(chain.state.unknownCalls).toEqual([]);
  });

  it("recovers a no-event factory replay and checks the real vault binding getters", async () => {
    const { chain, client } = fixture();
    chain.state.noCreationEvents = true;
    expect(isVaultSetup(vaultSetup)).toBe(true);
    const hash = chain.submit({
      to: addresses.factory,
      data: encodeFunctionData({
        abi: vaultFactoryAbi,
        functionName: "createVault",
        args: [
          setupRequestIds.vault,
          configuration.vaultName,
          addresses.collection,
          1n,
          addresses.wallet,
          addresses.wallet,
          addresses.wallet,
        ],
      }),
    });
    expect((await client.getTransactionReceipt({ hash })).logs).toEqual([]);
    await expect(recoverCreatedVault(client, vaultSetup)).resolves.toBe(
      addresses.vault,
    );
    expect(chain.state.unknownCalls).toEqual([]);
  });

  it("keeps approval, custody and fixed issuance pending until their own receipts", async () => {
    const { chain, client } = fixture();
    for (const [action, address, data] of [
      [
        "approve",
        addresses.collection,
        encodeFunctionData({
          abi: erc721VaultApprovalAbi,
          functionName: "approve",
          args: [addresses.vault, 1n],
        }),
      ],
      [
        "deposit",
        addresses.vault,
        encodeFunctionData({ abi: artFiVaultAbi, functionName: "deposit" }),
      ],
      [
        "issue",
        addresses.vault,
        encodeFunctionData({
          abi: artFiVaultAbi,
          functionName: "fractionalize",
          args: [
            configuration.tokenName,
            configuration.tokenSymbol,
            BigInt(configuration.tokenSupply),
            addresses.wallet,
          ],
        }),
      ],
    ] as const) {
      chain.state.outcomes[action] = "pending";
      const hash = chain.submit({ to: address, data });
      expect(
        chain.rpc({
          id: 1,
          method: "eth_getTransactionReceipt",
          params: [hash],
        }).result,
      ).toBeNull();
      chain.state.outcomes[action] = "success";
      const receipt = await client.getTransactionReceipt({ hash });
      expect(receipt.status).toBe("success");
      if (action === "approve") {
        await expect(
          client.readContract({
            abi: erc721VaultApprovalAbi,
            address: addresses.collection,
            functionName: "getApproved",
            args: [1n],
          }),
        ).resolves.toBe(addresses.vault);
      } else if (action === "deposit") {
        await expect(
          client.readContract({
            abi: erc721VaultApprovalAbi,
            address: addresses.collection,
            functionName: "ownerOf",
            args: [1n],
          }),
        ).resolves.toBe(addresses.vault);
      } else {
        const event = parseEventLogs({
          abi: artFiVaultAbi,
          eventName: "Fractionalized",
          logs: receipt.logs,
          strict: true,
        })[0];
        expect(event.args).toEqual({
          token: addresses.fraction,
          recipient: addresses.wallet,
          supply: BigInt(configuration.tokenSupply),
        });
      }
    }
    expect(chain.state.transactions.map((entry) => entry.action)).toEqual([
      "approve",
      "deposit",
      "issue",
    ]);
    expect(chain.state.unknownCalls).toEqual([]);
  });

  it("a reverted approval receipt never changes the current token approval", async () => {
    const { chain, client } = fixture();
    chain.state.outcomes.approve = "reverted";
    const hash = chain.submit({
      to: addresses.collection,
      data: encodeFunctionData({
        abi: erc721VaultApprovalAbi,
        functionName: "approve",
        args: [addresses.vault, 1n],
      }),
    });
    expect((await client.getTransactionReceipt({ hash })).status).toBe(
      "reverted",
    );
    expect(chain.state.approved).toBe(false);
    expect(chain.state.deposited).toBe(false);
    expect(chain.state.owner).toBe(addresses.wallet);
  });
});
