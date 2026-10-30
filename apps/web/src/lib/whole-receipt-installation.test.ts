import { describe, expect, it, vi } from "vitest";
import { createExecutionFixture } from "./whole-receipt-execution.test-fixture";
import { nftTaskJournalDigest } from "./nft/task-journal";
import { kernelRequestDigest } from "../../../../scripts/agent/agent-kernel.mjs";
import {
  createWholeReceiptInstallation,
  type ReceiptInstallationAuthority,
  type ReceiptInstallationOptions,
  type ReceiptInstallationRuntime,
  type ReceiptRuntimeFactory,
} from "./whole-receipt-installation";

/** TEST_ONLY structural SDK, authority and mTLS ports. Product composition runs
 * unchanged; these cases do not prove real grants, peers, stores or deployment. */
function installationFixture(phase: "funded" | "registered" | "paid" = "paid") {
  const f = createExecutionFixture(phase);
  const store = {},
    journalStore = {};
  const consumerPeerId = "spiffe://test.invalid/native-journal";
  const { withCapability, ...journal } = f.options.journalConfig;
  let authority: ReceiptInstallationAuthority | null = null;
  let stopped = false;
  const assertIndependentStore = vi.fn((candidate: object) => {
    if (candidate === store) throw Error("TEST_ONLY_SHARED_STORE");
  });
  const configured: ReceiptInstallationAuthority = {
    ...f.options.runtime.authority!,
    readState: vi.fn(async () => ({ status: "TEST_ONLY" })),
    assertIndependentStore,
  };
  const connect = vi.fn((selected: ReceiptInstallationAuthority) => {
    selected.assertIndependentStore(journalStore);
    authority = selected;
    return authority;
  });
  const consume = vi.fn((request: unknown, peer: string) => {
    if (peer !== consumerPeerId)
      throw Error("TEST_ONLY_AUTHENTICATED_PEER_REFUSED");
    if (stopped && !f.state.held) throw Error("TEST_ONLY_RUNTIME_STOPPED");
    return { request, peer, result: "TEST_ONLY_REGISTRY_CONSUMED" };
  });
  const stop = vi.fn(() => {
    stopped = true;
  });
  const runtime: ReceiptInstallationRuntime = {
    state: "configured",
    get authority() {
      return authority;
    },
    inHeldGate: f.options.runtime.inHeldGate,
    connectAuthorization: connect,
    withCapability,
    consumeCapability: consume,
    stop,
  };
  const factory = vi.fn(
    (_input: Parameters<ReceiptRuntimeFactory>[0]) => runtime,
  );
  const options: ReceiptInstallationOptions = {
    createTaskReceiptRuntime: factory,
    createProviderHandler: f.options.createProviderHandler,
    store,
    journalStore,
    consumerPeerId,
    taskExecutorIdentity: {
      identity: { version: "TEST_ONLY" },
      digest: f.principal.executorDigest,
    },
    provider: f.options.provider,
    journal,
    now: f.options.now,
  };
  const create = () => createWholeReceiptInstallation(options);
  const connectInstallation = () => {
    const installation = create();
    installation.connectAuthorization(configured);
    return installation;
  };
  const selected = () => ({ task: f.options.task, claimed: f.claimed });
  return {
    ...f,
    options,
    store,
    journalStore,
    runtime,
    configured,
    connect,
    consume,
    stop,
    factory,
    assertIndependentStore,
    consumerPeerId,
    create,
    connectInstallation,
    selected,
  };
}

describe("fixed whole receipt installation composition", () => {
  it("registers the original executor and fixed handler without opening a grant or journal", () => {
    const f = installationFixture();
    const installation = f.create();
    expect(installation.authOptions).toEqual({
      taskReceiptHandlerId: "artfi:whole-receipt:v1",
      taskExecutorIdentity: f.options.taskExecutorIdentity,
    });
    expect(f.factory).toHaveBeenCalledTimes(1);
    const input = f.factory.mock.calls[0]![0];
    expect(input.store).toBe(f.store);
    expect(input.journalStore).toBe(f.journalStore);
    expect(input.peerId).toBe(f.options.journal.peerId);
    expect(input.consumerPeerId).toBe(f.consumerPeerId);
    expect(input.digest).toBe(nftTaskJournalDigest);
    expect(input.nativeDigest).toBe(kernelRequestDigest);
    expect(input.now).toBe(f.options.now);
    expect(f.state.gates).toBe(0);
    expect(f.state.bodies).toHaveLength(0);
    expect(f.connect).not.toHaveBeenCalled();
    expect(Object.isFrozen(installation.authOptions)).toBe(true);
    expect(Object.isFrozen(installation.authOptions.taskExecutorIdentity)).toBe(
      true,
    );
  });

  it("does not retain a mutable executor identity", () => {
    const f = installationFixture();
    const executor = {
      identity: { version: "TEST_ONLY_ORIGINAL" },
      digest: f.principal.executorDigest,
    };
    f.options.taskExecutorIdentity = executor;
    const installation = f.create();
    executor.identity.version = "TEST_ONLY_CHANGED";
    expect(installation.authOptions.taskExecutorIdentity).toEqual({
      identity: { version: "TEST_ONLY_ORIGINAL" },
      digest: f.principal.executorDigest,
    });
  });

  it("refuses a shared store before constructing the SDK runtime", () => {
    const f = installationFixture();
    f.options.journalStore = f.store;
    expect(f.create).toThrow("RECEIPT_INSTALLATION_CONFIG_REFUSED");
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("does not accept a caller-supplied capability callback as a second gate", () => {
    const f = installationFixture();
    Object.assign(f.options.journal, { withCapability: vi.fn() });
    expect(f.create).toThrow("RECEIPT_INSTALLATION_CONFIG_REFUSED");
    expect(f.factory).not.toHaveBeenCalled();
  });

  it("requires the one original authorization connection before operation construction", () => {
    const f = installationFixture();
    const installation = f.create();
    expect(() => installation.operation(f.selected())).toThrow(
      "RECEIPT_INSTALLATION_AUTHORIZATION_NOT_CONNECTED",
    );
    expect(() => installation.consumeCapability({}, f.consumerPeerId)).toThrow(
      "RECEIPT_INSTALLATION_AUTHORIZATION_NOT_CONNECTED",
    );
    expect(f.state.gates).toBe(0);
    expect(f.state.bodies).toHaveLength(0);
  });

  it("connects once and delegates the actual independent-store check to the authority", () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    expect(f.connect).toHaveBeenCalledExactlyOnceWith(f.configured);
    expect(f.assertIndependentStore).toHaveBeenCalledExactlyOnceWith(
      f.journalStore,
    );
    expect(() => installation.connectAuthorization(f.configured)).toThrow(
      "RECEIPT_INSTALLATION_ALREADY_CONNECTED",
    );
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it("stops a rejected connection and never retries it through the same installation", () => {
    const f = installationFixture();
    f.assertIndependentStore.mockImplementation(() => {
      throw Error("TEST_ONLY_ORIGINAL_STORE_REFUSAL");
    });
    const installation = f.create();
    expect(() => installation.connectAuthorization(f.configured)).toThrow(
      "TEST_ONLY_ORIGINAL_STORE_REFUSAL",
    );
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(() => installation.connectAuthorization(f.configured)).toThrow(
      "RECEIPT_INSTALLATION_STOPPED",
    );
    expect(() => installation.operation(f.selected())).toThrow(
      "RECEIPT_INSTALLATION_STOPPED",
    );
    expect(f.connect).toHaveBeenCalledTimes(1);
  });

  it.each(["funded", "registered", "paid"] as const)(
    "binds the %s phase to the original single gate, native CAS and complete principal",
    async (phase) => {
      const f = installationFixture(phase);
      const installation = f.connectInstallation();
      const operation = installation.operation(f.selected());
      const prepared = await operation.create(f.native, f.wire);
      expect(prepared.operation.plan.taskPrincipal).toEqual(f.principal);
      const result = await operation.execute(f.request);
      expect(result.status).toBe("pending");
      expect(f.state.gates).toBe(1);
      expect(f.state.sendCalls).toBe(1);
      expect(f.state.trace.indexOf("cas-started")).toBeLessThan(
        f.state.trace.indexOf("send"),
      );
      expect(f.state.row.plan).toEqual(f.native);
      expect(f.state.row.plan.taskPrincipal).toEqual(f.principal);
      expect(f.state.submitted).toBe(f.state.row.transactionHash);
      expect(f.state.held).toBe(false);
      expect(f.factory).toHaveBeenCalledTimes(1);
      expect(f.assertIndependentStore).toHaveBeenCalledTimes(1);
      expect(
        f.state.bodies.every(
          (body) => !/"(?:data|signature|proof|rawTransaction)"/.test(body),
        ),
      ).toBe(true);
      await expect(
        installation.operation(f.selected()).execute(f.request),
      ).rejects.toThrow("RECEIPT_RECOVER_EXISTING_OPERATION");
      expect(f.state.sendCalls).toBe(1);
    },
  );

  it("copies task and claim data before the caller can mutate them", async () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    const task = {
      policy: structuredClone(f.policy),
      digest: f.principal.taskDigest,
    };
    const claimed = { ...f.claimed };
    const operation = installation.operation({ task, claimed });
    task.policy.intent.sale.price = "999";
    claimed.planDigest = "0x" + "0".repeat(64);
    await expect(operation.execute(f.request)).resolves.toMatchObject({
      status: "pending",
    });
    expect(f.state.sendCalls).toBe(1);
  });

  it("refuses task accessors without invoking them or opening a gate", () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    let reads = 0;
    const task = { policy: {}, digest: f.principal.taskDigest };
    Object.defineProperty(task, "policy", {
      enumerable: true,
      get() {
        reads++;
        return f.policy;
      },
    });
    expect(() => installation.operation({ task, claimed: f.claimed })).toThrow(
      "RECEIPT_INSTALLATION_CONFIG_REFUSED",
    );
    expect(reads).toBe(0);
    expect(f.state.gates).toBe(0);
    expect(f.state.bodies).toHaveLength(0);
  });

  it("passes the unchanged consume payload and authenticated peer to the original registry", () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    const request = {
      capability: "TEST_ONLY",
      peerId: f.options.journal.peerId,
      action: "get",
      nativeOperationId: f.native.operationId,
      planDigest: "",
      requestDigest: "1".repeat(64),
    };
    expect(installation.consumeCapability(request, f.consumerPeerId)).toEqual({
      request,
      peer: f.consumerPeerId,
      result: "TEST_ONLY_REGISTRY_CONSUMED",
    });
    expect(f.consume.mock.calls[0]![0]).toBe(request);
    expect(() =>
      installation.consumeCapability(request, "spiffe://test.invalid/foreign"),
    ).toThrow("TEST_ONLY_AUTHENTICATED_PEER_REFUSED");
  });

  it("stops once and fences already-created operations before any new work", async () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    const operation = installation.operation(f.selected());
    installation.stop();
    installation.stop();
    expect(f.stop).toHaveBeenCalledTimes(1);
    await expect(operation.read()).rejects.toThrow(
      "RECEIPT_INSTALLATION_STOPPED",
    );
    await expect(operation.create(f.native, f.wire)).rejects.toThrow(
      "RECEIPT_INSTALLATION_STOPPED",
    );
    await expect(operation.execute(f.request)).rejects.toThrow(
      "RECEIPT_INSTALLATION_STOPPED",
    );
    expect(() => installation.operation(f.selected())).toThrow(
      "RECEIPT_INSTALLATION_STOPPED",
    );
    expect(f.state.bodies).toHaveLength(0);
    expect(f.state.gates).toBe(0);
    expect(() => installation.consumeCapability({}, f.consumerPeerId)).toThrow(
      "TEST_ONLY_RUNTIME_STOPPED",
    );
  });

  it("lets an accepted send drain and record its known hash after stop", async () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    const operation = installation.operation(f.selected());
    let release!: () => void, entered!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.state.sendWait = async () => {
      entered();
      await wait;
    };
    const first = operation.execute(f.request);
    await sending;
    installation.stop();
    expect(
      installation.consumeCapability(
        { capability: "TEST_ONLY_ACCEPTED" },
        f.consumerPeerId,
      ),
    ).toMatchObject({ result: "TEST_ONLY_REGISTRY_CONSUMED" });
    release();
    await expect(first).resolves.toMatchObject({ status: "pending" });
    expect(f.state.row.transactionHash).toBe(f.state.submitted);
    expect(f.state.row.status).toBe("pending");
    expect(f.state.sendCalls).toBe(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects an unexpected shared connected runtime without stopping it", () => {
    const f = installationFixture();
    f.runtime.connectAuthorization(f.configured);
    expect(f.create).toThrow("RECEIPT_INSTALLATION_RUNTIME_REFUSED");
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.runtime.authority).toBe(f.configured);
  });

  it.each([
    "http://journal.invalid/internal/v1/nft/operations",
    "https://journal.invalid/foreign",
    "https://journal.invalid/internal/v1/nft/operations?token=TEST_ONLY",
  ])(
    "rejects a changed internal journal endpoint before creating the runtime: %s",
    (url) => {
      const f = installationFixture();
      f.options.journal.url = url;
      expect(f.create).toThrow("RECEIPT_INSTALLATION_CONFIG_REFUSED");
      expect(f.factory).not.toHaveBeenCalled();
    },
  );

  it("preserves unknown-send reconciliation and never fabricates another attempt", async () => {
    const f = installationFixture();
    const installation = f.connectInstallation();
    const operation = installation.operation(f.selected());
    f.state.providerUnknown = true;
    await expect(operation.execute(f.request)).rejects.toThrow(
      "RECEIPT_WALLET_OUTCOME_UNKNOWN_READ_FIRST",
    );
    expect((await operation.read()).operation.walletStarted).toBe(true);
    await expect(
      installation.operation(f.selected()).execute(f.request),
    ).rejects.toThrow("RECEIPT_RECOVER_EXISTING_OPERATION");
    expect(f.state.sendCalls).toBe(1);
    expect(f.state.row.transactionHash).toBeUndefined();
  });
});
