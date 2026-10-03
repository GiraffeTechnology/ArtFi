import { describe, expect, it, vi } from "vitest";
import {
  type Address,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  zeroAddress,
} from "viem";
import { confirmMarketReceipt } from "./market-transaction";
import { createSetupRecoverySession } from "./setup-recovery";
import {
  assertVaultBinding,
  isVaultSetup,
  loadVaultAccess,
  recoverCreatedVault,
  recordConfirmedVaultCreation,
  vaultCreationSubmission,
  vaultConnectionKey,
  type VaultSetup,
} from "./vault-setup";
const wallet = "0x1000000000000000000000000000000000000010" as Address;
const other = "0x1000000000000000000000000000000000000020" as Address;
const vault = "0x1000000000000000000000000000000000000030" as Address;
const setup: VaultSetup = {
  chainId: 560048,
  walletAddress: wallet,
  factoryAddress: other,
  idempotencyKey: "1234567890123456",
  stage: "configure",
  configuration: {
    collectionAddress: wallet,
    tokenId: "1",
    vaultName: "TEST_ONLY Vault",
    adminAddress: wallet,
    pauserAddress: wallet,
    fractionalizerAddress: wallet,
    tokenName: "TEST_ONLY Fractions",
    tokenSymbol: "TEST",
    tokenSupply: "1000000000000000000000",
    recipient: wallet,
  },
  intent: {
    intentId: "public-intent",
    requestId: `0x${"12".repeat(32)}`,
    chainId: 560048,
    factoryAddress: other,
    collectionAddress: wallet,
    tokenId: "1",
    vaultName: "TEST_ONLY Vault",
    adminAddress: wallet,
    pauserAddress: wallet,
    fractionalizerAddress: wallet,
  },
};
function client(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    vaultForRequest: vault,
    vaultByAsset: vault,
    collection: wallet,
    tokenId: 1n,
    tokenAdmin: wallet,
    vaultName: "TEST_ONLY Vault",
    PAUSER_ROLE: `0x${"22".repeat(32)}`,
    FRACTIONALIZER_ROLE: `0x${"33".repeat(32)}`,
    hasRole: true,
    ...overrides,
  };
  return {
    readContract: async ({ functionName }: { functionName: string }) =>
      values[functionName],
  } as unknown as Pick<PublicClient, "readContract">;
}
describe("exact Vault intent and replay binding", () => {
  it.each([
    ["chainId", 1],
    ["factoryAddress", wallet],
    ["collectionAddress", other],
    ["tokenId", "2"],
    ["vaultName", "Changed name"],
    ["adminAddress", other],
    ["pauserAddress", other],
    ["fractionalizerAddress", other],
  ])("rejects changed %s before signing", (field, value) => {
    expect(() =>
      assertVaultBinding({ ...setup.intent!, [field]: value }, setup),
    ).toThrow("every reviewed");
  });
  it("restores a creation replay through existing getters without requiring a new event", async () => {
    await expect(recoverCreatedVault(client(), setup)).resolves.toBe(vault);
  });
  it.each([
    ["vaultForRequest", zeroAddress],
    ["vaultByAsset", other],
    ["collection", other],
    ["tokenId", 2n],
    ["tokenAdmin", other],
    ["vaultName", "Wrong vault"],
    ["hasRole", false],
  ])("rejects a recovered mismatched %s", async (field, value) => {
    await expect(
      recoverCreatedVault(client({ [field]: value }), setup),
    ).rejects.toThrow();
  });
  it("validates persisted reviewed supply, roles and completed-stage identity", () => {
    expect(isVaultSetup(setup)).toBe(true);
    expect(isVaultSetup({ ...setup, stage: "complete" })).toBe(false);
    expect(
      isVaultSetup({
        ...setup,
        configuration: { ...setup.configuration, tokenSupply: "0" },
      }),
    ).toBe(false);
    expect(
      isVaultSetup({
        ...setup,
        configuration: {
          ...setup.configuration,
          tokenId: (2n ** 256n).toString(),
        },
      }),
    ).toBe(false);
    expect(
      isVaultSetup({
        ...setup,
        intent: { ...setup.intent, adminAddress: other },
      }),
    ).toBe(false);
  });
});

describe("canonical Vault submission logging", () => {
  it("cannot log a timed-out pending hash, then logs only the repriced successful hash", async () => {
    const original = `0x${"41".repeat(32)}` as Hash;
    const canonical = `0x${"42".repeat(32)}` as Hash;
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const session = createSetupRecoverySession("vault-test", isVaultSetup);
    session.restore(() => storage);
    const lease = session.begin()!;
    session.save(lease, setup);
    session.awaitWallet(lease, "create");
    session.broadcast(lease, original);
    // Older records could contain these fields before a receipt. Both UI and HTTP must refuse them.
    session.save(lease, {
      ...setup,
      creationHash: original,
      submissionPending: true,
    });
    const timeout = {
      waitForTransactionReceipt: async () => {
        throw new Error("RPC timeout");
      },
    } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
    await expect(confirmMarketReceipt(timeout, original)).rejects.toThrow(
      "not yet confirmed",
    );
    session.finish(lease);
    const post = vi.fn(
      async (submission: { intentId: string; transactionHash: Hash }) =>
        submission,
    );
    const manualRetry = session.begin(true)!;
    expect(
      vaultCreationSubmission(session.getSnapshot().record),
    ).toBeUndefined();
    await recordConfirmedVaultCreation(session.getSnapshot().record, post);
    expect(post).not.toHaveBeenCalled();
    expect(session.getSnapshot().record?.pending?.hash).toBe(original);
    session.finish(manualRetry);
    expect(session.begin()).toBeUndefined();
    const checking = session.begin(true)!;
    const receipt = {
      transactionHash: canonical,
      status: "success",
      logs: [],
    } as unknown as TransactionReceipt;
    const repriced = {
      waitForTransactionReceipt: async ({
        onReplaced,
      }: {
        onReplaced: (replacement: unknown) => void;
      }) => {
        onReplaced({ reason: "repriced", transactionReceipt: receipt });
        return receipt;
      },
    } as unknown as Pick<PublicClient, "waitForTransactionReceipt">;
    const confirmed = await confirmMarketReceipt(repriced, original, (hash) =>
      session.repriced(checking, hash),
    );
    const verifiedVault = await recoverCreatedVault(client(), setup);
    session.resolved(checking, {
      ...setup,
      stage: "created",
      vaultAddress: verifiedVault,
      creationHash: confirmed.transactionHash,
      submissionPending: true,
    });
    await recordConfirmedVaultCreation(session.getSnapshot().record, post);
    expect(post.mock.calls).toEqual([
      [{ intentId: setup.intent!.intentId, transactionHash: canonical }],
    ]);
  });

  it("does not manufacture a canonical hash from getter-only or unresolved wallet recovery", async () => {
    const post = vi.fn(async () => ({}));
    const recovered = {
      ...setup,
      stage: "created" as const,
      vaultAddress: vault,
      submissionPending: true,
    };
    await recordConfirmedVaultCreation(
      { id: "getter-only", data: recovered },
      post,
    );
    await recordConfirmedVaultCreation(
      {
        id: "unknown",
        data: setup,
        pending: { id: "wallet-prompt", step: "create" },
      },
      post,
    );
    expect(post).not.toHaveBeenCalled();
  });
});

it("retires the DAO view when connecting keeps the same prior address and chain", () => {
  const connected = vaultConnectionKey(wallet, 560048, true);
  const connecting = vaultConnectionKey(wallet, 560048, false);
  expect(connecting).not.toBe(connected);
  expect(vaultConnectionKey(wallet, 560048, true)).toBe(connected);
});

it("keeps readable public factory config on an initial real 401 and after operator verification", async () => {
  const config = { chainId: 560048, vaultFactoryAddress: other };
  const before = await loadVaultAccess(
    async () => {
      throw Object.assign(new Error("No operator cookie"), { status: 401 });
    },
    async () => config,
  );
  expect(before).toEqual({
    session: { authenticated: false },
    config,
    sessionError: undefined,
  });
  const after = await loadVaultAccess(
    async () => ({ authenticated: true, address: wallet }),
    async () => config,
  );
  expect(after.session.authenticated).toBe(true);
  expect(after.config).toBe(config);
});
it("keeps genuine session-service failures visible without discarding public deployment config", async () => {
  const result = await loadVaultAccess(
    async () => {
      throw Object.assign(new Error("Operator service unavailable"), {
        status: 503,
      });
    },
    async () => ({ chainId: 560048, vaultFactoryAddress: other }),
  );
  expect(result.session.authenticated).toBe(false);
  expect(result.config.vaultFactoryAddress).toBe(other);
  expect(result.sessionError).toBe("Operator service unavailable");
});
