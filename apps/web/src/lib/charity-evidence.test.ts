import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeEventTopics,
  encodeFunctionData,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { charityEditionsAbi } from "./contracts";
import { reviewSafeSubmission } from "./admin-safe-client";
import {
  charityEvidenceCall,
  charityEvidenceFlow,
  charityEvidenceSafeSubmission,
  checkCharityEvidencePreconditions,
  isCharityEvidenceRecord,
  prepareCharityEvidence,
  verifyCharityEvidenceReceipt,
  verifyDirectCharityEvidenceTransaction,
  type CharityEvidenceRecord,
  type CharityEvidenceState,
} from "./charity-evidence";

const account = `0x${"11".repeat(20)}` as Address;
const target = `0x${"22".repeat(20)}` as Address;
const safe = `0x${"33".repeat(20)}` as Address;
const evidenceHash = `0x${"44".repeat(32)}` as Hex;
const txHash = `0x${"55".repeat(32)}` as Hex;
const blockHash = `0x${"66".repeat(32)}` as Hex;
const record = (
  action: "sellout" | "donation" = "sellout",
): CharityEvidenceRecord => ({
  chainId: 560048,
  account,
  target,
  tokenId: "7",
  action,
  evidenceHash,
});
const state = (values = {}): CharityEvidenceState => ({
  distributionWallet: account,
  createdAt: 1n,
  soldOutAt: 0n,
  physicalDonationRecordedAt: 0n,
  selloutEvidenceHash: zeroHash,
  physicalDonationEvidenceHash: zeroHash,
  ...values,
});
function clientFor(s = state()) {
  const readContract = vi.fn(async (call: { functionName: string }) => {
    switch (call.functionName) {
      case "series":
        return s;
      case "paused":
        return false;
      case "balanceOf":
        return 0n;
      case "hasRole":
        return true;
      case "isOwner":
        return true;
      default:
        throw Error("Unexpected call");
    }
  });
  const mock = {
    getChainId: vi.fn(async () => 560048),
    getBlock: vi.fn(async () => ({
      number: 10n,
      hash: blockHash,
      timestamp: s.physicalDonationRecordedAt || s.soldOutAt || 2n,
    })),
    readContract,
    simulateContract: vi.fn(async () => ({})),
    getTransaction: vi.fn(async () => ({
      from: account,
      to: target,
      value: 0n,
      input: encodeFunctionData(charityEvidenceCall(record())),
    })),
  };
  return { mock, client: mock as unknown as PublicClient };
}
function receiptFor(r = record()): TransactionReceipt {
  const topics = encodeEventTopics({
    abi: charityEditionsAbi,
    eventName:
      r.action === "sellout" ? "SelloutRecorded" : "PhysicalDonationRecorded",
    args: { tokenId: 7n, evidenceHash: r.evidenceHash },
  });
  return {
    status: "success",
    transactionHash: txHash,
    blockNumber: 10n,
    blockHash,
    logs: [{ address: target, topics, data: "0x", removed: false }],
  } as unknown as TransactionReceipt;
}

describe("bounded charity evidence calls", () => {
  it.each(["sellout", "donation"] as const)(
    "binds %s to the existing selector, exact series/evidence and zero-value Safe submission",
    (action) => {
      const r = record(action),
        call = charityEvidenceCall(r),
        submission = charityEvidenceSafeSubmission(r);
      expect(
        decodeFunctionData({ abi: charityEditionsAbi, data: submission.data }),
      ).toEqual({ functionName: call.functionName, args: [7n, evidenceHash] });
      expect(submission.value).toBe(0n);
      expect(
        reviewSafeSubmission(
          charityEvidenceFlow(action),
          target,
          submission,
          7n,
        ).namedArgs,
      ).toEqual({ tokenId: 7n, evidenceHash });
      expect(() =>
        reviewSafeSubmission(
          charityEvidenceFlow(action),
          target,
          submission,
          8n,
        ),
      ).toThrow();
    },
  );
  it.each([
    { chainId: 1 },
    { tokenId: "0" },
    { tokenId: "07" },
    { tokenId: (2n ** 256n).toString() },
    { evidenceHash: zeroHash },
    { target: `0x${"00".repeat(20)}` },
    { action: "transfer" },
    { privateFile: "do-not-store" },
  ])("refuses malformed/expanded public recovery bindings %j", (change) => {
    const invalid = { ...record(), ...change };
    expect(isCharityEvidenceRecord(invalid)).toBe(false);
    expect(() =>
      charityEvidenceCall(invalid as CharityEvidenceRecord),
    ).toThrow();
  });
  it("requires a recorded sellout before physical acceptance, without demanding a current zero balance again", () => {
    expect(() =>
      checkCharityEvidencePreconditions(record("donation"), state(), false),
    ).toThrow(/Sellout must be recorded/);
    expect(() =>
      checkCharityEvidencePreconditions(
        record("donation"),
        state({ soldOutAt: 2n, selloutEvidenceHash: evidenceHash }),
        false,
        5n,
      ),
    ).not.toThrow();
  });
  it("refuses paused, nonzero-balance and already-recorded actions", () => {
    expect(() =>
      checkCharityEvidencePreconditions(record(), state(), true, 0n),
    ).toThrow(/paused/);
    expect(() =>
      checkCharityEvidencePreconditions(record(), state(), false, 1n),
    ).toThrow(/zero units/);
    expect(() =>
      checkCharityEvidencePreconditions(
        record(),
        state({ soldOutAt: 2n }),
        false,
        0n,
      ),
    ).toThrow(/already recorded/);
    expect(() =>
      checkCharityEvidencePreconditions(
        record("donation"),
        state({ soldOutAt: 2n, physicalDonationRecordedAt: 3n }),
        false,
      ),
    ).toThrow(/already recorded/);
  });
  it("reads series/pause/balance at one block and simulates the direct recorder call", async () => {
    const { client, mock } = clientFor();
    const result = await prepareCharityEvidence(client, record());
    expect(result.caller).toBe(account);
    expect(result.safeSubmission).toBeUndefined();
    for (const [call] of mock.readContract.mock.calls.filter(([call]) =>
      ["series", "paused", "balanceOf"].includes(call.functionName),
    ))
      expect(call).toMatchObject({ blockNumber: 10n });
    expect(mock.simulateContract).toHaveBeenCalledWith({
      ...charityEvidenceCall(record()),
      account,
    });
  });
  it("routes to a role-holding Safe for an independent owner and prepares its exact proposal", async () => {
    const { client, mock } = clientFor();
    const result = await prepareCharityEvidence(client, record(), safe);
    expect(result.caller).toBe(safe);
    expect(result.safeSubmission).toEqual(
      charityEvidenceSafeSubmission(record()),
    );
    expect(mock.simulateContract).toHaveBeenCalledWith({
      ...charityEvidenceCall(record()),
      account: safe,
    });
  });
  it("does not simulate or prepare a write on the wrong chain", async () => {
    const { client, mock } = clientFor();
    mock.getChainId.mockResolvedValue(1);
    await expect(prepareCharityEvidence(client, record())).rejects.toThrow(
      /Hoodi/,
    );
    expect(mock.simulateContract).not.toHaveBeenCalled();
  });
  it("does not use a Safe address as a role grant or bypass owner verification", async () => {
    const { client, mock } = clientFor();
    mock.readContract.mockImplementation(async (call) =>
      call.functionName === "isOwner"
        ? false
        : call.functionName === "series"
          ? state()
          : call.functionName === "balanceOf"
            ? 0n
            : call.functionName === "paused"
              ? false
              : true,
    );
    await expect(
      prepareCharityEvidence(client, record(), safe),
    ).rejects.toThrow(/owners/);
    expect(mock.simulateContract).not.toHaveBeenCalled();
  });
});

describe("original evidence transaction and canonical receipt recovery", () => {
  it("accepts only the exact original direct sender/target/input and zero value", async () => {
    const { client } = clientFor();
    await expect(
      verifyDirectCharityEvidenceTransaction(client, record(), txHash),
    ).resolves.toBeUndefined();
  });
  it.each([{ from: safe }, { to: safe }, { value: 1n }, { input: "0x" }])(
    "refuses substituted direct transaction case %#",
    async (change) => {
      const { client, mock } = clientFor();
      mock.getTransaction.mockResolvedValue({
        ...(await mock.getTransaction()),
        ...change,
      } as never);
      await expect(
        verifyDirectCharityEvidenceTransaction(client, record(), txHash),
      ).rejects.toThrow();
    },
  );
  it.each(["sellout", "donation"] as const)(
    "reconciles %s only from its exact event and recorded canonical hash",
    async (action) => {
      const r = record(action),
        s = state({
          soldOutAt: 2n,
          selloutEvidenceHash: evidenceHash,
          ...(action === "donation"
            ? {
                physicalDonationRecordedAt: 3n,
                physicalDonationEvidenceHash: evidenceHash,
              }
            : {}),
        });
      const { client, mock } = clientFor(s);
      await expect(
        verifyCharityEvidenceReceipt(client, r, receiptFor(r)),
      ).resolves.toMatchObject({
        action,
        tokenId: "7",
        transactionHash: txHash,
      });
      expect(mock.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: "series", blockNumber: 10n }),
      );
    },
  );
  it("leaves mismatched events, missing events and reverted receipts unconfirmed", async () => {
    const { client } = clientFor(
      state({ soldOutAt: 2n, selloutEvidenceHash: evidenceHash }),
    );
    await expect(
      verifyCharityEvidenceReceipt(client, record(), {
        ...receiptFor(),
        logs: [],
      }),
    ).rejects.toThrow();
    await expect(
      verifyCharityEvidenceReceipt(
        client,
        record(),
        receiptFor({ ...record(), evidenceHash: txHash }),
      ),
    ).rejects.toThrow();
    await expect(
      verifyCharityEvidenceReceipt(client, record(), {
        ...receiptFor(),
        status: "reverted",
      }),
    ).rejects.toThrow();
    const removed = receiptFor();
    await expect(
      verifyCharityEvidenceReceipt(client, record(), {
        ...removed,
        logs: removed.logs.map((log) => ({ ...log, removed: true })),
      }),
    ).rejects.toThrow();
  });
  it("refuses a receipt if the canonical block or stored evidence disagrees", async () => {
    const { client, mock } = clientFor(
      state({ soldOutAt: 2n, selloutEvidenceHash: evidenceHash }),
    );
    mock.getBlock.mockResolvedValue({
      number: 10n,
      hash: txHash,
      timestamp: 2n,
    });
    await expect(
      verifyCharityEvidenceReceipt(client, record(), receiptFor()),
    ).rejects.toThrow(/canonical chain/);
    const wrong = clientFor(
      state({ soldOutAt: 2n, selloutEvidenceHash: txHash }),
    );
    await expect(
      verifyCharityEvidenceReceipt(wrong.client, record(), receiptFor()),
    ).rejects.toThrow(/canonical chain/);
    const wrongTime = clientFor(
      state({ soldOutAt: 2n, selloutEvidenceHash: evidenceHash }),
    );
    wrongTime.mock.getBlock.mockResolvedValue({
      number: 10n,
      hash: blockHash,
      timestamp: 3n,
    });
    await expect(
      verifyCharityEvidenceReceipt(wrongTime.client, record(), receiptFor()),
    ).rejects.toThrow(/canonical chain/);
  });
});
