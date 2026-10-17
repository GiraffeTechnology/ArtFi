import { describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  type Hex,
} from "viem";
import {
  createWholeReceiptChainVerifier,
  wholeReceiptProjectionReadAbi,
  type ReceiptChainReadRequest,
} from "./whole-receipt-chain-verifier";
import { wholeReceiptSourceSchemaId } from "./whole-receipt-source-observation-model";
vi.mock("server-only", () => ({}));
const h = (c: string) => `0x${c.repeat(64)}` as Hex,
  a = (c: string) => `0x${c.repeat(40)}`;
type Input = Parameters<ReceiptChainReadRequest>[0];

/** Synthetic read-only RPC in the exact source ABI. It is not a real chain,
 * finality proof, source institution, grant or installed provider. */
function fixture() {
  const expected = {
    tokenId: "7",
    source: {
      chainId: "560048",
      contract: a("3"),
      registerId: h("1"),
      sourceAuthority: a("4"),
    },
    mintPolicyHash: h("2"),
    entry: {
      recordCommitment: h("3"),
      previousCommitment: h("0"),
      registryReference: h("4"),
      holder: a("b"),
      version: "2",
      effectiveAt: "100",
    },
    receiptBinding: {
      schemaId: wholeReceiptSourceSchemaId,
      mintPolicyHash: h("2"),
      segmentDigest: h("5"),
      requestHash: h("6"),
      receiptDocumentHash: h("7"),
    },
  };
  const snapshot = {
    ...structuredClone(expected),
    block: { number: "10", hash: h("b") },
    entry: { ...expected.entry, supersededAt: "0" },
    receiptAvailable: true,
  };
  const code = "0x60016000" as Hex;
  const state = {
    calls: [] as Input[],
    names: [] as string[],
    results: {
      registerId: expected.source.registerId,
      sourceAuthority: expected.source.sourceAuthority,
      mintPolicyHash: expected.mintPolicyHash,
      entryAt: {
        ...expected.entry,
        version: 2n,
        effectiveAt: 100n,
        supersededAt: 0n,
      },
      receiptBinding: { ...expected.receiptBinding },
      isFinalAsOf: false,
    } as Record<string, unknown>,
    code: code as string,
    finalized: { number: "0xc", hash: h("c") },
    anchorReads: 0,
    chainReads: 0,
    orphanOnRecheck: false,
    switchChain: false,
    appendedReturnBytes: false,
    rejectCanonical: false,
    failMethod: undefined as Input["method"] | undefined,
    neverMethod: undefined as Input["method"] | undefined,
    beforeRpc: undefined as undefined | (() => Promise<void>),
  };
  const request: ReceiptChainReadRequest = async (input) => {
    state.calls.push(structuredClone(input));
    await state.beforeRpc?.();
    if (input.method === state.neverMethod) return new Promise(() => {});
    if (input.method === state.failMethod)
      throw Error("PRIVATE_RPC_OR_SOURCE_DIAGNOSTIC");
    switch (input.method) {
      case "eth_chainId":
        state.chainReads++;
        return state.switchChain && state.chainReads > 1 ? "0x7a69" : "0x88bb0";
      case "eth_getBlockByNumber":
        if (input.params[0] === "finalized") return structuredClone(state.finalized);
        if (input.params[0] === "0xa") {
          state.anchorReads++;
          return { number: "0xa", hash: state.orphanOnRecheck && state.anchorReads > 1 ? h("9") : h("b") };
        }
        if (input.params[0] === state.finalized.number) return structuredClone(state.finalized);
        throw Error("UNEXPECTED_BLOCK");
      case "eth_getCode":
        if (state.rejectCanonical) throw Error("EIP1898_UNSUPPORTED");
        return state.code;
      case "eth_call": {
        if (state.rejectCanonical) throw Error("EIP1898_UNSUPPORTED");
        const transaction = input.params[0] as { to: string; data: Hex };
        expect(transaction.to).toBe(a("3"));
        const decoded = decodeFunctionData({
          abi: wholeReceiptProjectionReadAbi, data: transaction.data,
        });
        const name = decoded.functionName;
        if (!name || !Object.hasOwn(state.results, name)) throw Error("UNEXPECTED_SELECTOR");
        state.names.push(name);
        if (["entryAt", "receiptBinding"].includes(name))
          expect(decoded.args).toEqual([7n, 2n]);
        if (name === "isFinalAsOf") expect(decoded.args).toEqual([7n, 100n]);
        if (name === "mintPolicyHash") expect(decoded.args).toEqual([7n]);
        const result = encodeFunctionResult({
          abi: wholeReceiptProjectionReadAbi, functionName: name, result: state.results[name],
        });
        return state.appendedReturnBytes ? result + "00" : result;
      }
    }
  };
  const options = {
    chainId: "560048" as const,
    contract: a("3"),
    runtimeCodeHash: keccak256(code),
    request,
  };
  const verifier = createWholeReceiptChainVerifier(options);
  return { expected, snapshot, state, options, verifier };
}

describe("canonical Oracle receipt source read", () => {
  it("rechecks the complete source record at one exact canonical block without authorizing execution", async () => {
    const f = fixture();
    const result = await f.verifier.verify(f.expected, f.snapshot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.code);
    expect(result.verification.snapshot).toEqual(f.snapshot);
    expect(result.verification).toMatchObject({
      chainFinality: "FINALIZED",
      projectionFinalAsOf: false,
      projectionInstant: "100",
      authorization: "NOT_ESTABLISHED",
      originalDocumentVerification: "NOT_ESTABLISHED",
      runtimeCodeHash: f.options.runtimeCodeHash,
    });
    expect(Object.isFrozen(result.verification.snapshot.entry)).toBe(true);
    expect(f.state.names).toEqual([
      "registerId", "sourceAuthority", "mintPolicyHash", "entryAt",
      "receiptBinding", "isFinalAsOf",
    ]);
    for (const input of f.state.calls) {
      expect(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"]).toContain(input.method);
      if (input.method === "eth_getCode" || input.method === "eth_call")
        expect(input.params[1]).toEqual({ blockHash: h("b"), requireCanonical: true });
    }
  });
  it("keeps canonical chain finality separate from temporal register finality", async () => {
    const f = fixture();
    f.state.finalized.number = "0x8";
    f.state.results.isFinalAsOf = true;
    const result = await f.verifier.verify(f.expected, f.snapshot);
    expect(result.ok && result.verification.chainFinality).toBe("NOT_FINALIZED");
    expect(result.ok && result.verification.projectionFinalAsOf).toBe(true);
    expect(result.ok && result.verification.authorization).toBe("NOT_ESTABLISHED");
  });
  it.each(["registerId", "sourceAuthority", "mintPolicyHash", "receiptBinding"] as const)(
    "refuses a foreign on-chain %s without a fallback source",
    async (name) => {
      const f = fixture();
      f.state.results[name] = name === "receiptBinding"
        ? { ...f.expected.receiptBinding, requestHash: h("9") }
        : name === "sourceAuthority" ? a("5") : h("9");
      expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
        ok: false, code: "RECEIPT_CHAIN_SNAPSHOT_REFUSED",
      });
    },
  );
  it.each([
    "recordCommitment", "previousCommitment", "registryReference", "holder",
    "version", "effectiveAt", "supersededAt",
  ])("refuses a changed on-chain register entry %s", async (key) => {
    const f = fixture();
    const entry = f.state.results.entryAt as Record<string, unknown>;
    entry[key] = key === "holder" ? a("c") : key === "version" ? 3n
      : key === "effectiveAt" ? 101n : key === "supersededAt" ? 200n : h("9");
    expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
      ok: false, code: "RECEIPT_CHAIN_SNAPSHOT_REFUSED",
    });
  });
  it("accepts the same historically closed interval without calling it current ownership", async () => {
    const f = fixture();
    f.snapshot.entry.supersededAt = "200";
    (f.state.results.entryAt as Record<string, unknown>).supersededAt = 200n;
    f.state.results.isFinalAsOf = true;
    const result = await f.verifier.verify(f.expected, f.snapshot);
    expect(result.ok && result.verification.snapshot.entry.supersededAt).toBe("200");
    expect(f.state.names).not.toContain("ownerOf");
  });
  it("refuses legacy zero mint policy and zero receipt fields", async () => {
    const f = fixture();
    f.state.results.mintPolicyHash = h("0");
    expect((await f.verifier.verify(f.expected, f.snapshot)).ok).toBe(false);
    const other = fixture();
    other.state.results.receiptBinding = {
      schemaId: h("0"), mintPolicyHash: h("0"), segmentDigest: h("0"),
      requestHash: h("0"), receiptDocumentHash: h("0"),
    };
    expect((await other.verifier.verify(other.expected, other.snapshot)).ok).toBe(false);
  });
  it("refuses an unexpected runtime code hash or missing contract code", async () => {
    for (const code of ["0x", "0x6000"]) {
      const f = fixture();
      f.state.code = code;
      expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
        ok: false, code: "RECEIPT_CHAIN_SNAPSHOT_REFUSED",
      });
      expect(f.state.names).toEqual([]);
    }
  });
  it("refuses unsupported EIP-1898 rather than reading latest", async () => {
    const f = fixture();
    f.state.rejectCanonical = true;
    expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
      ok: false, code: "RECEIPT_CHAIN_UNAVAILABLE",
    });
    expect(f.state.calls.some((input) => input.params.includes("latest"))).toBe(false);
  });
  it("refuses a changed canonical anchor and changed chain after the state reads", async () => {
    for (const key of ["orphanOnRecheck", "switchChain"] as const) {
      const f = fixture();
      f.state[key] = true;
      expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
        ok: false, code: "RECEIPT_CHAIN_SNAPSHOT_REFUSED",
      });
    }
  });
  it("refuses contradictory finalized-block identity", async () => {
    const f = fixture();
    f.state.finalized = { number: "0xa", hash: h("9") };
    expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
      ok: false, code: "RECEIPT_CHAIN_SNAPSHOT_REFUSED",
    });
  });
  it("refuses appended ABI bytes", async () => {
    const f = fixture();
    f.state.appendedReturnBytes = true;
    expect(await f.verifier.verify(f.expected, f.snapshot)).toEqual({
      ok: false, code: "RECEIPT_CHAIN_SNAPSHOT_REFUSED",
    });
  });
  it("refuses malformed block quantities and accessors without evaluating a getter", async () => {
    const f = fixture();
    f.state.finalized.number = "0x0c";
    expect((await f.verifier.verify(f.expected, f.snapshot)).ok).toBe(false);
    const other = fixture();
    let invoked = false;
    Object.defineProperty(other.snapshot.block, "hash", {
      enumerable: true, get() { invoked = true; return h("b"); },
    });
    expect((await other.verifier.verify(other.expected, other.snapshot)).ok).toBe(false);
    expect(invoked).toBe(false);
    expect(other.state.calls).toEqual([]);
  });
  it("checks installation identity before any RPC and captures the installed configuration", async () => {
    const f = fixture();
    f.expected.source.contract = a("8");
    f.snapshot.source.contract = a("8");
    expect((await f.verifier.verify(f.expected, f.snapshot)).ok).toBe(false);
    expect(f.state.calls).toEqual([]);
    const other = fixture();
    other.options.contract = a("8");
    other.options.runtimeCodeHash = h("9");
    expect((await other.verifier.verify(other.expected, other.snapshot)).ok).toBe(true);
  });
  it("snapshots both expectations and observations before the first asynchronous read", async () => {
    const f = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    f.state.beforeRpc = () => pending;
    const attempt = f.verifier.verify(f.expected, f.snapshot);
    f.expected.entry.holder = a("8");
    f.snapshot.entry.holder = a("9");
    release();
    const result = await attempt;
    expect(result.ok && result.verification.snapshot.entry.holder).toBe(a("b"));
  });
  it("returns only a fixed code for upstream failures and performs no write or retry", async () => {
    const f = fixture();
    f.state.failMethod = "eth_call";
    const result = await f.verifier.verify(f.expected, f.snapshot);
    expect(result).toEqual({ ok: false, code: "RECEIPT_CHAIN_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(f.state.calls.filter((x) => x.method === "eth_call")).toHaveLength(1);
  });
  it("cancels before any RPC", async () => {
    const f = fixture(), controller = new AbortController();
    controller.abort();
    expect(await f.verifier.verify(f.expected, f.snapshot, controller.signal)).toEqual({
      ok: false, code: "RECEIPT_CHAIN_CANCELLED",
    });
    expect(f.state.calls).toEqual([]);
  });
  it("bounds a stalled provider and does not issue later reads after timeout", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.state.neverMethod = "eth_chainId";
      const attempt = f.verifier.verify(f.expected, f.snapshot);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await attempt).toEqual({ ok: false, code: "RECEIPT_CHAIN_TIMEOUT" });
      expect(f.state.calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("refuses missing code pins, unsupported chains and extra installation fields", () => {
    const f = fixture();
    for (const options of [
      { ...f.options, runtimeCodeHash: h("0") },
      { ...f.options, chainId: "1" },
      { ...f.options, endpoint: "https://untrusted.example" },
    ]) {
      expect(() => createWholeReceiptChainVerifier(options as typeof f.options))
        .toThrow("RECEIPT_CHAIN_CONFIG_INVALID");
    }
  });
});
