import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { NftPlanRecorder } from "./recorder";

const holder = "0x1111111111111111111111111111111111111111" as Address;
const firstTarget = "0x2222222222222222222222222222222222222222";
const otherTarget = "0x3333333333333333333333333333333333333333";
const transaction = (to = firstTarget) => ({ to, data: "0x1234", value: 7n });
const domain = { chainId: 1, name: "TEST_ONLY order" };
const types = { OrderComponents: [{ name: "amount", type: "uint256" }] };
const failure = (promise: Promise<unknown>) => promise.catch((error) => error);

function pendingTransaction(recorder: NftPlanRecorder) {
  let finish!: (value: string) => void;
  const to = new Promise<string>((resolve) => {
    finish = resolve;
  });
  return {
    finish,
    result: failure(recorder.sendTransaction({ ...transaction(), to })),
  };
}

describe("nft recorder reservation regression", () => {
  it("does not admit a second transaction while the first is unresolved", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    const first = pendingTransaction(recorder);
    try {
      await failure(recorder.sendTransaction(transaction(otherTarget)));
      expect(recorder.captured).toBeUndefined();
    } finally {
      first.finish(firstTarget);
      await first.result;
    }
    expect(recorder.captured).toEqual({
      transaction: { to: firstTarget, data: "0x1234", value: "7" },
    });
  });
  it("does not admit typed data while the first transaction is unresolved", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    const first = pendingTransaction(recorder);
    try {
      await failure(recorder.signTypedData(domain, types, { amount: 5n }));
      expect(recorder.captured).toBeUndefined();
    } finally {
      first.finish(firstTarget);
      await first.result;
    }
    expect(recorder.captured).toHaveProperty("transaction.to", firstTarget);
  });
  it("does not let serialization reentry replace the first typed-data request", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    let reentry: Promise<unknown> | undefined;
    const message = {
      get amount() {
        reentry = failure(recorder.sendTransaction(transaction(otherTarget)));
        return 5n;
      },
    };
    await failure(recorder.signTypedData(domain, types, message));
    await reentry;
    expect(recorder.captured).toHaveProperty("typedData.message.amount", "5");
    expect(recorder.captured).not.toHaveProperty("transaction");
  });
  it("does not substitute a later plan after the first transaction is invalid", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    await expect(
      recorder.sendTransaction({ data: "0x1234", value: 7n }),
    ).rejects.toHaveProperty("status", 422);
    await failure(recorder.sendTransaction(transaction(otherTarget)));
    expect(recorder.captured).toBeUndefined();
  });
  it("does not substitute a later plan after typed-data serialization fails", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      recorder.signTypedData(domain, types, cyclic),
    ).rejects.toThrow();
    await failure(recorder.sendTransaction(transaction(otherTarget)));
    expect(recorder.captured).toBeUndefined();
  });
  it("does not substitute a later plan after the first promised field rejects", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    await expect(
      recorder.sendTransaction({
        ...transaction(),
        to: Promise.reject(new Error("TEST_ONLY field failure")),
      }),
    ).rejects.toThrow("TEST_ONLY field failure");
    await failure(recorder.signTypedData(domain, types, { amount: 5n }));
    expect(recorder.captured).toBeUndefined();
  });
});

describe("nft recorder retained preparation boundaries", () => {
  it("captures the first transaction losslessly and never overwrites it", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    const amount = (1n << 200n) + 123n;
    await expect(
      recorder.sendTransaction({
        ...transaction(),
        from: holder,
        value: amount,
      }),
    ).rejects.toHaveProperty("status", 409);
    const captured = recorder.captured;
    expect(captured).toEqual({
      transaction: {
        to: firstTarget,
        data: "0x1234",
        value: amount.toString(),
      },
    });
    await failure(recorder.sendTransaction(transaction(otherTarget)));
    await failure(recorder.signTypedData(domain, types, { amount: 5n }));
    expect(recorder.captured).toBe(captured);
  });
  it("preserves the first typed-data envelope and exact bigint value", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    const amount = (1n << 200n) + 123n;
    await failure(recorder.signTypedData(domain, types, { amount }));
    expect(recorder.captured).toEqual({
      typedData: {
        domain,
        types,
        message: { amount: amount.toString() },
        primaryType: "OrderComponents",
      },
    });
    await failure(recorder.sendTransaction(transaction(otherTarget)));
    expect(recorder.captured).toHaveProperty(
      "typedData.message.amount",
      amount.toString(),
    );
  });
  it("does not freeze a separate preparation or connected recorder", async () => {
    const original = new NftPlanRecorder(holder, null);
    await failure(original.sendTransaction({ data: "0x1234" }));
    const fresh = new NftPlanRecorder(holder, null);
    const connected = original.connect(null);
    await failure(fresh.sendTransaction(transaction()));
    await failure(connected.sendTransaction(transaction(otherTarget)));
    expect(original.captured).toBeUndefined();
    expect(fresh.captured).toHaveProperty("transaction.to", firstTarget);
    expect(connected.captured).toHaveProperty("transaction.to", otherTarget);
  });
  it("retains the prohibition on server-side wallet signing", async () => {
    const recorder = new NftPlanRecorder(holder, null);
    await expect(recorder.signMessage()).rejects.toHaveProperty("status", 403);
    await expect(recorder.signTransaction()).rejects.toHaveProperty(
      "status",
      403,
    );
    expect(recorder.captured).toBeUndefined();
  });
});
