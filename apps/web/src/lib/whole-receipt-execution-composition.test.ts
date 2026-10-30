import { describe, expect, it } from "vitest";
import { createExecutionFixture } from "./whole-receipt-execution.test-fixture";

describe("whole receipt preparation, held dispatch and durable acknowledgement", () => {
  it.each(["funded", "registered", "paid"] as const)(
    "composes the exact %s phase through one authorization and CAS before one dispatch",
    async (phase) => {
      const f = createExecutionFixture(phase),
        service = f.create();
      const result = await service.execute(f.request);
      expect(result.status).toBe("pending");
      expect(f.state.gates).toBe(1);
      expect(f.state.sendCalls).toBe(1);
      expect(f.state.trace.indexOf("cas-started")).toBeLessThan(
        f.state.trace.indexOf("send"),
      );
      expect(f.state.trace.filter((x) => x === "journal:update")).toHaveLength(
        2,
      );
      expect(f.state.row.revision).toBe(3);
      expect(f.state.row.walletStarted).toBe(true);
      expect(f.state.row.status).toBe("pending");
      expect(f.state.row.plan).toEqual(f.native);
      expect(f.state.row.plan.taskPrincipal).toEqual(f.principal);
      expect(f.state.submitted).toBe(f.state.row.transactionHash);
      expect(f.state.held).toBe(false);
      expect(
        f.state.bodies.every(
          (body) => !/"(?:data|signature|proof|rawTransaction)"/.test(body),
        ),
      ).toBe(true);
    },
  );
  it("reuses exact idempotent preparation without resetting a progressed record", async () => {
    const f = createExecutionFixture(),
      service = f.create();
    await service.execute(f.request);
    const before = structuredClone(f.state.row);
    const result = await service.create(f.native, f.wire);
    expect(result.operation).toEqual(before);
    expect(f.state.sendCalls).toBe(1);
  });
  it.each(["walletStarted", "transactionHash", "status"] as const)(
    "refuses another dispatch for an already progressed %s record",
    async (field) => {
      const f = createExecutionFixture();
      if (field === "walletStarted") f.state.row.walletStarted = true;
      if (field === "transactionHash") {
        f.state.row.walletStarted = true;
        f.state.row.transactionHash = `0x${"f".repeat(64)}`;
        f.state.row.status = "pending";
      }
      if (field === "status") f.state.row.status = "cancelled";
      await expect(f.create().execute(f.request)).rejects.toThrow(
        "RECEIPT_RECOVER_EXISTING_OPERATION",
      );
      expect(f.state.gates).toBe(0);
      expect(f.state.sendCalls).toBe(0);
    },
  );
  it("refuses a corrupt awaiting-wallet row carrying a transaction hash", async () => {
    const f = createExecutionFixture();
    f.state.row.walletStarted = true;
    f.state.row.transactionHash = `0x${"f".repeat(64)}`;
    await expect(f.create().execute(f.request)).rejects.toThrow(
      "RECEIPT_JOURNAL_ROW_REFUSED",
    );
    expect(f.state.gates).toBe(0);
    expect(f.state.sendCalls).toBe(0);
  });
  it("keeps an unknown CAS acknowledgement marked and does not send", async () => {
    const f = createExecutionFixture();
    f.state.loseCASAck = true;
    await expect(f.create().execute(f.request)).rejects.toThrow();
    expect(f.state.row.walletStarted).toBe(true);
    expect(f.state.sendCalls).toBe(0);
    await expect(f.create().execute(f.request)).rejects.toThrow(
      "RECEIPT_RECOVER_EXISTING_OPERATION",
    );
  });
  it("does not send after a CAS conflict", async () => {
    const f = createExecutionFixture();
    f.state.failCAS = true;
    await expect(f.create().execute(f.request)).rejects.toThrow();
    expect(f.state.row.walletStarted).toBe(false);
    expect(f.state.sendCalls).toBe(0);
  });
  it.each(["expiry", "revocation", "account"] as const)(
    "retains the durable marker when %s changes after CAS",
    async (change) => {
      const f = createExecutionFixture();
      f.state.afterCAS = () => {
        if (change === "expiry") f.state.now = 10000;
        if (change === "revocation") f.state.revoked = true;
        if (change === "account") f.state.actor = `0x${"7".repeat(40)}`;
      };
      await expect(f.create().execute(f.request)).rejects.toThrow();
      expect(f.state.row.walletStarted).toBe(true);
      expect(f.state.sendCalls).toBe(0);
    },
  );
  it("does not expose a provider error or replay an unknown send", async () => {
    const f = createExecutionFixture();
    f.state.providerUnknown = true;
    await expect(f.create().execute(f.request)).rejects.toThrow(
      "RECEIPT_WALLET_OUTCOME_UNKNOWN_READ_FIRST",
    );
    expect(f.state.sendCalls).toBe(1);
    expect(f.state.row.walletStarted).toBe(true);
    expect(f.state.row.transactionHash).toBeUndefined();
    await expect(f.create().execute(f.request)).rejects.toThrow(
      "RECEIPT_RECOVER_EXISTING_OPERATION",
    );
    expect(f.state.sendCalls).toBe(1);
  });
  it("does not acknowledge a zero provider hash", async () => {
    const f = createExecutionFixture();
    f.state.zeroHash = true;
    await expect(f.create().execute(f.request)).rejects.toThrow(
      "RECEIPT_WALLET_OUTCOME_UNKNOWN_READ_FIRST",
    );
    expect(f.state.row.transactionHash).toBeUndefined();
    expect(f.state.row.walletStarted).toBe(true);
  });
  it.each(["loseSubmissionAck", "rejectSubmission"] as const)(
    "retains the known Wallet hash when %s prevents the native acknowledgement",
    async (failure) => {
      const f = createExecutionFixture();
      f.state[failure] = true;
      const service = f.create(),
        result = await service.execute(f.request);
      expect(result).toEqual({
        status: "submission-recording-unknown",
        operationId: service.operationId,
        transactionHash: `0x${"f".repeat(64)}`,
      });
      expect(f.state.submitted).toBe(`0x${"f".repeat(64)}`);
      expect(f.state.sendCalls).toBe(1);
      expect((await service.read()).operation.walletStarted).toBe(true);
      await expect(f.create().execute(f.request)).rejects.toThrow(
        "RECEIPT_RECOVER_EXISTING_OPERATION",
      );
      expect(f.state.sendCalls).toBe(1);
    },
  );
  it("reconciles a committed pending record after the Wallet gate acknowledgement is lost", async () => {
    const f = createExecutionFixture();
    f.state.gateAckUnknown = true;
    const service = f.create();
    await expect(service.execute(f.request)).rejects.toThrow();
    expect((await service.read()).operation.status).toBe("pending");
    expect(f.state.sendCalls).toBe(1);
    await expect(f.create().execute(f.request)).rejects.toThrow(
      "RECEIPT_RECOVER_EXISTING_OPERATION",
    );
  });
  it("permits read recovery after expiry and revocation, without a new send gate", async () => {
    const f = createExecutionFixture(),
      service = f.create();
    await service.execute(f.request);
    f.state.now = 10001;
    f.state.revoked = true;
    const result = await service.read();
    expect(result.operation.status).toBe("pending");
    expect(f.state.gates).toBe(1);
    expect(f.state.sendCalls).toBe(1);
  });
  it("copies the exact request before an asynchronous journal read", async () => {
    const f = createExecutionFixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.beforeRead = () => wait;
    const request = { ...f.request };
    const result = f.create().execute(request);
    request.to = `0x${"5".repeat(40)}`;
    release();
    await expect(result).resolves.toMatchObject({ status: "pending" });
    expect(f.state.sendCalls).toBe(1);
  });
  it("refuses request accessors without invoking them or accessing the journal", async () => {
    const f = createExecutionFixture();
    let reads = 0;
    const request = { ...f.request };
    Object.defineProperty(request, "data", {
      enumerable: true,
      get() {
        reads++;
        return f.request.data;
      },
    });
    await expect(f.create().execute(request)).rejects.toThrow(
      "RECEIPT_EXECUTION_REQUEST_REFUSED",
    );
    expect(reads).toBe(0);
    expect(f.state.bodies).toHaveLength(0);
  });
  it("rejects duplicate calls while the first journal read is unresolved", async () => {
    const f = createExecutionFixture(),
      service = f.create();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.beforeRead = () => wait;
    const first = service.execute(f.request);
    await expect(service.execute(f.request)).rejects.toThrow(
      "RECEIPT_EXECUTION_REENTRY_REFUSED",
    );
    release();
    await first;
    expect(f.state.sendCalls).toBe(1);
  });
  it("refuses changed business and foreign task records before authorization", async () => {
    const f = createExecutionFixture();
    f.state.row.plan.taskPrincipal.taskId = "foreign-task";
    await expect(f.create().execute(f.request)).rejects.toThrow();
    expect(f.state.gates).toBe(0);
    expect(f.state.sendCalls).toBe(0);
  });
});
