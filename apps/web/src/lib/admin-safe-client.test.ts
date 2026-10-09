import { describe, expect, it, vi } from "vitest";
import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { encodeOperatorSafeSubmission } from "./admin-safe";
import {
  artFiAdminSafeAbi,
  charityEditionsAbi,
  vaultFactoryAbi,
} from "./contracts";
import {
  assertSameSafeSubmission,
  isSafeRecord,
  existingSafeSubmission,
  loadSafeProposal,
  operatorCallRoute,
  recordSubmission,
  reviewSafeSubmission,
  verifySafeTransaction,
  vaultRoleDefaults,
  type SafeRecord,
} from "./admin-safe-client";
import { createSetupRecoverySession } from "./setup-recovery";
import { operatorErrorText } from "./operator-error";

const wallet = "0x1111111111111111111111111111111111111111" as Address;
const safe = "0x2222222222222222222222222222222222222222" as Address;
const target = "0x3333333333333333333333333333333333333333" as Address;
const requestId = `0x${"41".repeat(32)}` as Hex;
const hash = `0x${"42".repeat(32)}` as Hex;
const submission = encodeOperatorSafeSubmission({
  target,
  requestId,
  abi: vaultFactoryAbi,
  functionName: "createVault",
  args: [requestId, "TEST_ONLY Vault", target, 1n, wallet, wallet, wallet],
});
const record: SafeRecord = {
  chainId: 560048,
  wallet,
  safe,
  kind: "vault",
  startBlock: "10",
  submission: {
    requestId: submission.requestId,
    target,
    data: submission.data,
  },
};
const client = (readContract: ReturnType<typeof vi.fn>) =>
  ({ readContract }) as unknown as PublicClient;

describe("configured safe routing", () => {
  it("uses a role-holding safe only for its owner", async () => {
    const read = vi.fn().mockResolvedValue(true);
    expect(
      await operatorCallRoute(client(read), "vault", target, wallet, safe),
    ).toBe(safe);
    expect(read.mock.calls.map(([call]) => call.functionName)).toEqual([
      "hasRole",
      "isOwner",
    ]);
  });
  it("keeps direct role holders when no safe holds the target role", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    expect(
      await operatorCallRoute(client(read), "vault", target, wallet, safe),
    ).toBe(wallet);
  });
  it("reports a wallet that is not an owner of its role-holding safe", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      operatorCallRoute(client(read), "vault", target, wallet, safe),
    ).rejects.toThrow(/one of its owners/);
  });
});
describe("unsigned exact call review", () => {
  it("decodes the existing Vault creation fields", () => {
    expect(reviewSafeSubmission("vault", target, submission)).toMatchObject({
      functionName: "createVault",
      args: [requestId, "TEST_ONLY Vault", target, 1n, wallet, wallet, wallet],
    });
  });
  it("keeps the charity edition function and zero-value boundary", () => {
    const call = encodeOperatorSafeSubmission({
      target,
      requestId,
      abi: charityEditionsAbi,
      functionName: "createSeries",
      args: [requestId, hash, hash, wallet, "ipfs://TEST_ONLY"],
    });
    expect(reviewSafeSubmission("charity", target, call).functionName).toBe(
      "createSeries",
    );
    expect(call.value).toBe(0n);
  });
  it("reports when a proposal belongs to a different deployed target", () => {
    expect(() => reviewSafeSubmission("vault", safe, submission)).toThrow(
      /reviewed target/,
    );
  });
  it("compares a recovered proposal to all original reviewed call bytes", () => {
    expect(() =>
      assertSameSafeSubmission(submission, { ...submission }),
    ).not.toThrow();
    expect(() =>
      assertSameSafeSubmission(submission, { ...submission, requestId: hash }),
    ).toThrow(/exact reviewed call/);
  });
});
describe("chain-backed proposal status", () => {
  it("reads owner confirmation, threshold and timelock at one observed block", async () => {
    const values = {
      threshold: 2n,
      delaySeconds: 60,
      isOwner: true,
      owners: [wallet, target],
      confirmedBy: false,
      transaction: {
        ...submission,
        confirmations: 1,
        readyAt: 0n,
        executed: false,
      },
    };
    const readContract = vi.fn(
      async ({ functionName }: { functionName: keyof typeof values }) =>
        values[functionName],
    );
    const rpc = {
      readContract,
      getBlock: vi.fn().mockResolvedValue({ number: 12n, timestamp: 100n }),
    } as unknown as PublicClient;
    const state = await loadSafeProposal(rpc, safe, wallet, 1n);
    expect(state).toMatchObject({
      threshold: 2n,
      delay: 60n,
      confirmed: false,
      now: 100n,
    });
    expect(
      readContract.mock.calls.every(
        ([call]) =>
          (call as unknown as { blockNumber: bigint }).blockNumber === 12n,
      ),
    ).toBe(true);
  });
});
describe("safe operation recovery", () => {
  it("restores a public proposal and unresolved transaction across reloads", () => {
    const values = new Map<string, string>();
    const store = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const first = createSetupRecoverySession("TEST_ONLY-safe", isSafeRecord);
    first.restore(() => store);
    const lease = first.begin()!;
    first.save(lease, record);
    first.awaitWallet(lease, "submit");
    first.broadcast(lease, hash);
    first.finish(lease);
    const reloaded = createSetupRecoverySession("TEST_ONLY-safe", isSafeRecord);
    reloaded.restore(() => store);
    expect(reloaded.getSnapshot().record?.pending).toMatchObject({
      step: "submit",
      hash,
    });
    expect(reloaded.begin()).toBeUndefined();
    expect(recordSubmission(reloaded.getSnapshot().record!.data)).toEqual(
      submission,
    );
  });
  it("matches a recovered submission hash to the original safe call", async () => {
    const input = encodeFunctionData({
      abi: artFiAdminSafeAbi,
      functionName: "submit",
      args: [submission.requestId, target, 0n, submission.data],
    });
    const rpc = {
      getTransaction: vi
        .fn()
        .mockResolvedValue({ to: safe, from: wallet, value: 0n, input }),
    } as unknown as PublicClient;
    await expect(
      verifySafeTransaction(rpc, hash, record, "submit"),
    ).resolves.toBeUndefined();
  });
  it("matches a confirmation to the independently selected proposal ID", async () => {
    const input = encodeFunctionData({
      abi: artFiAdminSafeAbi,
      functionName: "confirm",
      args: [3n],
    });
    const rpc = {
      getTransaction: vi
        .fn()
        .mockResolvedValue({ to: safe, from: wallet, value: 0n, input }),
    } as unknown as PublicClient;
    await expect(
      verifySafeTransaction(
        rpc,
        hash,
        { ...record, transactionId: "3" },
        "confirm",
      ),
    ).resolves.toBeUndefined();
  });
  it("keeps wallet error explanations readable without losing recovery state", () => {
    const error = Object.assign(new Error("User rejected. Raw call: 0x..."), {
      shortMessage: "User rejected the request.",
    });
    expect(operatorErrorText(error)).toBe("User rejected the request.");
    expect(operatorErrorText(new Error("Transaction remains pending."))).toBe(
      "Transaction remains pending.",
    );
  });
});

describe("new Vault role defaults", () => {
  it("keeps the original connected-wallet defaults in a direct deployment", () => {
    expect(vaultRoleDefaults(wallet)).toEqual({
      adminAddress: wallet,
      pauserAddress: wallet,
      fractionalizerAddress: wallet,
      recipient: wallet,
    });
  });
  it("defaults only blank admin and pauser roles to the safe execution authority", () => {
    expect(vaultRoleDefaults(wallet, safe)).toEqual({
      adminAddress: safe,
      pauserAddress: safe,
      fractionalizerAddress: wallet,
      recipient: wallet,
    });
  });
});

describe("idempotent proposal recovery", () => {
  it("recognizes an existing identical simulated proposal without another write", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(1n)
      .mockResolvedValueOnce(submission);
    expect(
      await existingSafeSubmission(client(read), safe, submission, 1n),
    ).toBe(true);
  });
  it("leaves a new simulated proposal for the explicit wallet submission", async () => {
    const read = vi.fn().mockResolvedValueOnce(0n);
    expect(
      await existingSafeSubmission(client(read), safe, submission, 1n),
    ).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
