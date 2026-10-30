import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  observeWholeReceiptSource,
  observeWholeReceiptReadResponse,
  snapshotWholeReceiptExpectation,
  wholeReceiptSourceSchemaId,
} from "./whole-receipt-source-observation-model";
import { readWholeReceiptSourceVersion } from "./whole-receipt-source-observation";

const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
function fixture() {
  const expected = {
    tokenId: "9007199254740993",
    source: {
      chainId: "560048",
      contract: address(1),
      registerId: hash(2),
      sourceAuthority: address(3),
    },
    mintPolicyHash: hash(4),
    entry: {
      recordCommitment: hash(5),
      previousCommitment: hash(6),
      registryReference: hash(7),
      holder: address(8),
      version: "2",
      effectiveAt: "9007199254740993",
    },
    receiptBinding: {
      schemaId: wholeReceiptSourceSchemaId as string,
      mintPolicyHash: hash(4),
      segmentDigest: hash(9),
      requestHash: hash(10),
      receiptDocumentHash: hash(11),
    },
  };
  const observed = {
    tokenId: expected.tokenId,
    source: structuredClone(expected.source),
    block: { number: "9007199254740995", hash: hash(12) },
    entry: { ...expected.entry, supersededAt: "0" },
    mintPolicyHash: expected.mintPolicyHash,
    receiptBinding: structuredClone(expected.receiptBinding),
    receiptAvailable: true,
  };
  return { expected, observed };
}
function oracleResponse(observed: ReturnType<typeof fixture>["observed"]) {
  return {
    ...observed,
    evidence: {
      kind: "canonical-contract-state" as const,
      head: { ...observed.block },
      minimumConfirmations: 1,
    },
  };
}
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("bound Oracle receipt source observations — synthetic only", () => {
  it("preserves full-width token/time/block strings and does not create authority", () => {
    const f = fixture(),
      result = observeWholeReceiptSource(f.expected, f.observed);
    expect(result.snapshot).toEqual(f.observed);
    expect(result.authorization).toBe("NOT_ESTABLISHED");
    expect(result.finality).toBe("NOT_ESTABLISHED");
    expect(result.originalDocumentVerification).toBe("NOT_ESTABLISHED");
    expect(Object.isFrozen(result.snapshot.receiptBinding)).toBe(true);
  });
  it("retains a subsequently closed historical interval without resetting time", () => {
    const f = fixture();
    f.observed.entry.supersededAt = "9007199254741000";
    const result = observeWholeReceiptSource(f.expected, f.observed);
    expect(result.snapshot.entry.supersededAt).toBe("9007199254741000");
    expect(result.snapshot.entry.effectiveAt).toBe(
      f.expected.entry.effectiveAt,
    );
  });
  it("rejects a different token or historic version", () => {
    for (const field of ["token", "version"]) {
      const f = fixture();
      if (field === "token") f.observed.tokenId = "3";
      else f.observed.entry.version = "3";
      expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
        "RECEIPT_BINDING_MISMATCH",
      );
    }
  });
  it("rejects every source domain substitution", () => {
    for (const field of [
      "chainId",
      "contract",
      "registerId",
      "sourceAuthority",
    ] as const) {
      const f = fixture();
      f.observed.source[field] =
        field === "chainId"
          ? "1"
          : field === "registerId"
            ? hash(999)
            : address(999);
      expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
        "RECEIPT_BINDING_MISMATCH",
      );
    }
  });
  it("compares all five receipt commitments without dropping fields", () => {
    for (const field of [
      "schemaId",
      "mintPolicyHash",
      "segmentDigest",
      "requestHash",
      "receiptDocumentHash",
    ] as const) {
      const f = fixture();
      f.observed.receiptBinding[field] = hash(999);
      expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow();
    }
  });
  it("rejects an unrelated mint policy even if the tuple repeats it", () => {
    const f = fixture();
    f.observed.mintPolicyHash = hash(999);
    f.observed.receiptBinding.mintPolicyHash = hash(999);
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_BINDING_MISMATCH",
    );
  });
  it("compares every immutable registration-entry field", () => {
    for (const field of [
      "recordCommitment",
      "previousCommitment",
      "registryReference",
      "holder",
      "effectiveAt",
    ] as const) {
      const f = fixture();
      f.observed.entry[field] =
        field === "holder"
          ? address(999)
          : field === "effectiveAt"
            ? "9007199254740994"
            : hash(999);
      expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
        "RECEIPT_BINDING_MISMATCH",
      );
    }
  });
  it("treats a wholly zero optional tuple as unavailable", () => {
    const f = fixture();
    for (const key of Object.keys(
      f.observed.receiptBinding,
    ) as (keyof typeof f.observed.receiptBinding)[])
      f.observed.receiptBinding[key] = hash(0);
    f.observed.receiptAvailable = false;
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_NOT_AVAILABLE",
    );
    f.observed.receiptAvailable = true;
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
  });
  it("rejects a partial tuple and false available flag on a complete tuple", () => {
    const f = fixture();
    f.observed.receiptBinding.requestHash = hash(0);
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
    f.observed.receiptBinding.requestHash =
      f.expected.receiptBinding.requestHash;
    f.observed.receiptAvailable = false;
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
  });
  it("rejects a legacy mint/version and incomplete expectations", () => {
    const f = fixture();
    f.expected.entry.version = "1";
    expect(() => snapshotWholeReceiptExpectation(f.expected)).toThrow(
      "RECEIPT_EXPECTATION_INVALID",
    );
    f.expected.entry.version = "2";
    f.expected.mintPolicyHash = hash(0);
    expect(() => snapshotWholeReceiptExpectation(f.expected)).toThrow(
      "RECEIPT_EXPECTATION_INVALID",
    );
  });
  it("rejects numeric and noncanonical integer values", () => {
    const f = fixture();
    expect(() =>
      observeWholeReceiptSource(f.expected, {
        ...f.observed,
        tokenId: 9007199254740993,
      }),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
    f.observed.entry.version = "02";
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
  });
  it("rejects uint64 overflow and invalid historical intervals", () => {
    const f = fixture();
    f.observed.entry.effectiveAt = (2n ** 64n).toString();
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
    f.observed.entry.effectiveAt = f.expected.entry.effectiveAt;
    f.observed.entry.supersededAt = f.expected.entry.effectiveAt;
    expect(() => observeWholeReceiptSource(f.expected, f.observed)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
  });
  it("rejects extra fields and missing block/source identity", () => {
    const f = fixture();
    expect(() =>
      observeWholeReceiptSource(f.expected, { ...f.observed, final: true }),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
    expect(() =>
      observeWholeReceiptSource(f.expected, {
        ...f.observed,
        block: undefined,
      }),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
    expect(() =>
      observeWholeReceiptSource(f.expected, {
        ...f.observed,
        source: { ...f.observed.source, sourceAuthority: address(0) },
      }),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
  });
  it("does not invoke expectation getters or keep input references", () => {
    const f = fixture(),
      getter = vi.fn(() => hash(999)),
      malformed = { ...f.expected };
    Object.defineProperty(malformed, "mintPolicyHash", {
      get: getter,
      enumerable: true,
    });
    expect(() => snapshotWholeReceiptExpectation(malformed)).toThrow(
      "RECEIPT_EXPECTATION_INVALID",
    );
    expect(getter).not.toHaveBeenCalled();
    const copy = snapshotWholeReceiptExpectation(f.expected);
    f.expected.entry.holder = address(999);
    expect(copy.entry.holder).not.toBe(f.expected.entry.holder);
  });
  it("does not invoke source getters", () => {
    const f = fixture(),
      getter = vi.fn(() => f.observed.block);
    const input = { ...f.observed };
    Object.defineProperty(input, "block", { get: getter, enumerable: true });
    expect(() => observeWholeReceiptSource(f.expected, input)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("complete Oracle receipt reader evidence", () => {
  it("retains the actual eight-field response without establishing authority", () => {
    const f = fixture(),
      wire = oracleResponse(f.observed),
      result = observeWholeReceiptReadResponse(f.expected, wire);
    expect(Object.keys(result.snapshot).sort()).toEqual([
      "block",
      "entry",
      "evidence",
      "mintPolicyHash",
      "receiptAvailable",
      "receiptBinding",
      "source",
      "tokenId",
    ]);
    expect(result.snapshot).toEqual(wire);
    expect(result.authorization).toBe("NOT_ESTABLISHED");
    expect(result.finality).toBe("NOT_ESTABLISHED");
    expect(result.originalDocumentVerification).toBe("NOT_ESTABLISHED");
    expect(Object.isFrozen(result.snapshot.evidence)).toBe(true);
    expect(Object.isFrozen(result.snapshot.evidence?.head)).toBe(true);
    wire.evidence.head.hash = hash(999);
    expect(result.snapshot.evidence?.head.hash).toBe(f.observed.block.hash);
  });
  it("keeps the seven-field internal snapshot separate from the HTTP contract", () => {
    const f = fixture();
    expect(observeWholeReceiptSource(f.expected, f.observed).snapshot).toEqual(
      f.observed,
    );
    expect(() =>
      observeWholeReceiptReadResponse(f.expected, f.observed),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
  });
  it("uses full-width inclusive confirmation arithmetic through the producer maximum", () => {
    const f = fixture(),
      wire = oracleResponse(f.observed);
    wire.evidence.minimumConfirmations = 256;
    wire.evidence.head = {
      number: String(BigInt(wire.block.number) + 255n),
      hash: hash(13),
    };
    expect(
      observeWholeReceiptReadResponse(f.expected, wire).snapshot.evidence,
    ).toEqual(wire.evidence);
  });
  type Evidence = ReturnType<typeof oracleResponse>["evidence"];
  const malformed: Array<[string, (e: Evidence) => unknown]> = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["foreign kind", (e) => ({ ...e, kind: "zk-proof" })],
    ["unknown field", (e) => ({ ...e, authorization: "VERIFIED" })],
    ["zero depth", (e) => ({ ...e, minimumConfirmations: 0 })],
    ["excessive depth", (e) => ({ ...e, minimumConfirmations: 257 })],
    ["fractional depth", (e) => ({ ...e, minimumConfirmations: 1.5 })],
    ["string depth", (e) => ({ ...e, minimumConfirmations: "1" })],
    ["missing depth", (e) => ({ kind: e.kind, head: e.head })],
    ["incomplete head", (e) => ({ ...e, head: { number: e.head.number } })],
    ["numeric head", (e) => ({ ...e, head: { ...e.head, number: 10 } })],
    [
      "noncanonical head",
      (e) => ({ ...e, head: { ...e.head, number: "0" + e.head.number } }),
    ],
    [
      "uint256 overflow",
      (e) => ({ ...e, head: { ...e.head, number: (1n << 256n).toString() } }),
    ],
    ["zero head hash", (e) => ({ ...e, head: { ...e.head, hash: hash(0) } })],
    ["short head hash", (e) => ({ ...e, head: { ...e.head, hash: "0x01" } })],
    [
      "unknown head field",
      (e) => ({ ...e, head: { ...e.head, url: "https://unexpected.invalid" } }),
    ],
    [
      "head behind anchor",
      (e) => ({
        ...e,
        head: { ...e.head, number: String(BigInt(e.head.number) - 1n) },
      }),
    ],
    ["insufficient depth", (e) => ({ ...e, minimumConfirmations: 2 })],
    [
      "same-height hash conflict",
      (e) => ({ ...e, head: { ...e.head, hash: hash(999) } }),
    ],
  ];
  it.each(malformed)("refuses %s reader evidence", (_name, change) => {
    const f = fixture(),
      wire = oracleResponse(f.observed);
    expect(() =>
      observeWholeReceiptReadResponse(f.expected, {
        ...wire,
        evidence: change(wire.evidence),
      }),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
  });
  it("does not weaken the exact root or the existing holder binding", () => {
    const f = fixture(),
      wire = oracleResponse(f.observed);
    expect(() =>
      observeWholeReceiptReadResponse(f.expected, {
        ...wire,
        unexpected: true,
      }),
    ).toThrow("RECEIPT_SOURCE_MALFORMED");
    wire.entry.holder = address(999);
    expect(() => observeWholeReceiptReadResponse(f.expected, wire)).toThrow(
      "RECEIPT_BINDING_MISMATCH",
    );
  });
  it("refuses an evidence accessor without invoking it", () => {
    const f = fixture(),
      wire = oracleResponse(f.observed);
    let calls = 0;
    Object.defineProperty(wire, "evidence", {
      enumerable: true,
      get() {
        calls++;
        return {};
      },
    });
    expect(() => observeWholeReceiptReadResponse(f.expected, wire)).toThrow(
      "RECEIPT_SOURCE_MALFORMED",
    );
    expect(calls).toBe(0);
  });
  it("rejects a successful HTTP body that omits reader evidence", async () => {
    const f = fixture();
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    const fetcher = vi.fn(async () => jsonResponse(f.observed));
    vi.stubGlobal("fetch", fetcher);
    expect(await readWholeReceiptSourceVersion(f.expected)).toEqual({
      ok: false,
      code: "RECEIPT_SOURCE_MALFORMED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("existing deployment-owned receipt transport", () => {
  it("reads one exact historical version using GET/no-store without browser credentials", async () => {
    const f = fixture(),
      fetcher = vi.fn(async () => jsonResponse(oracleResponse(f.observed)));
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid/bridge/");
    vi.stubGlobal("fetch", fetcher);
    const result = await readWholeReceiptSourceVersion(f.expected);
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.toString()).toBe(
      "https://oracle.invalid/bridge/v1/oracle/projection/9007199254740993/receipt/version/2",
    );
    expect(options).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    expect(options.body).toBeUndefined();
  });
  it("keeps the expectation snapshot when caller data changes during fetch", async () => {
    const f = fixture();
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        f.expected.entry.holder = address(999);
        return jsonResponse(oracleResponse(f.observed));
      }),
    );
    expect((await readWholeReceiptSourceVersion(f.expected)).ok).toBe(true);
  });
  it("does not fetch if complete expectations are missing", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await readWholeReceiptSourceVersion({})).toEqual({
      ok: false,
      code: "RECEIPT_EXPECTATION_INVALID",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps an unconfigured deployment unavailable", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
      ok: false,
      code: "RECEIPT_ORACLE_NOT_CONFIGURED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects credential/query/fragment and remote HTTP configuration", async () => {
    for (const url of [
      "https://user:secret@oracle.invalid",
      "https://oracle.invalid?q=1",
      "https://oracle.invalid/#x",
      "http://oracle.invalid",
    ]) {
      vi.stubEnv("ARTFI_ORACLE_READ_API_URL", url);
      expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
        ok: false,
        code: "RECEIPT_ORACLE_CONFIG_INVALID",
      });
    }
  });
  it("rejects redirects even from a nonconforming fetch adapter", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    const response = jsonResponse(oracleResponse(fixture().observed));
    Object.defineProperty(response, "redirected", { value: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
      ok: false,
      code: "RECEIPT_SOURCE_MALFORMED",
    });
  });
  it("does not fall back to current/legacy surfaces after 404", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    const fetcher = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
      ok: false,
      code: "RECEIPT_NOT_AVAILABLE",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("redacts provider failures and does not retry unavailable responses", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    const fetcher = vi.fn(async () => {
      throw Error("private upstream diagnostic");
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
      ok: false,
      code: "RECEIPT_SOURCE_UNAVAILABLE",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong content type and declared excessive body length", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    for (const headers of [
      { "content-type": "text/html" } as HeadersInit,
      {
        "content-type": "application/json",
        "content-length": "65537",
      } as HeadersInit,
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { headers })),
      );
      expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
        ok: false,
        code: "RECEIPT_SOURCE_MALFORMED",
      });
    }
  });
  it("bounds chunked data without a Content-Length", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(65537), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
      ok: false,
      code: "RECEIPT_SOURCE_MALFORMED",
    });
  });
  it("rejects malformed UTF-8 and malformed JSON", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    for (const body of [
      new Uint8Array([0xc3, 0x28]),
      new TextEncoder().encode("{"),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      expect(await readWholeReceiptSourceVersion(fixture().expected)).toEqual({
        ok: false,
        code: "RECEIPT_SOURCE_MALFORMED",
      });
    }
  });
  it("honors an already cancelled caller without fetching", async () => {
    const f = fixture(),
      signal = AbortSignal.abort(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await readWholeReceiptSourceVersion(f.expected, signal)).toEqual({
      ok: false,
      code: "RECEIPT_CANCELLED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("deadline covers a stalled response stream", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const result = readWholeReceiptSourceVersion(fixture().expected);
    await vi.advanceTimersByTimeAsync(4001);
    expect(await result).toEqual({ ok: false, code: "RECEIPT_TIMEOUT" });
  });
  it("caller cancellation covers a stalled response stream", async () => {
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.invalid");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const controller = new AbortController(),
      result = readWholeReceiptSourceVersion(
        fixture().expected,
        controller.signal,
      );
    await Promise.resolve();
    controller.abort();
    expect(await result).toEqual({ ok: false, code: "RECEIPT_CANCELLED" });
  });
});
