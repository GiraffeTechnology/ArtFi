import { describe, expect, it, vi } from "vitest";
import { type RwaAsset } from "./rwa-catalog";
import {
  readWholeReceiptStatus,
  receiptAssetKey,
  type WholeReceiptReadAdapter,
  type VerifiedReceiptEvent,
} from "./whole-receipt-reader";

const A = `0x${"a".repeat(40)}`;
const B = `0x${"b".repeat(40)}`;
const C = `0x${"c".repeat(40)}`;
const D = `0x${"d".repeat(40)}`;
const token = `0x${"1".repeat(40)}`;
const asset: RwaAsset = {
  slug: "test-only-receipt",
  title: "TEST_ONLY",
  artist: "TEST_ONLY",
  year: 2026,
  medium: "test",
  location: "test",
  description: "Isolated test fixture",
  section: "whole",
  rights: "TEST_ONLY / NO REAL-WORLD VALUE / NO LEGAL EFFECT",
  provenance: [],
  binding: { chainId: 560048, collectionAddress: token, tokenId: "1" },
  grounding: {
    status: "verified",
    mode: "TEST_ONLY",
    sourceId: "test-source",
    sourceName: "test source",
    sourceKind: "test",
    sourceReference: "test:1",
    evidenceSha256: "a".repeat(64),
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
    verifiedAt: "2026-10-12T00:00:00Z",
    registryBacked: true,
  },
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
  revision: 1,
};
function snapshot(registrarId = "external-registrar") {
  return {
    complete: true as const,
    binding: {
      assetId: receiptAssetKey(asset),
      chainId: 560048,
      collection: token,
      tokenId: "1",
      intermediaryId: "artfi",
      registrarId,
      oracleId: "trusted-oracle",
    },
    initialHolder: A,
    observedOwner: C,
    observedAt: "2026-10-12T00:00:00Z",
    sourceReference: "test-checkpoint:1",
    events: [
      {
        kind: "funded" as const,
        trade: {
          id: "AB",
          seller: A,
          buyer: B,
          paymentToken: token,
          amount: 100n,
          escrowReference: "funded:AB",
          ownerTransferReference: "owner:AB",
        },
      },
      {
        kind: "funded" as const,
        trade: {
          id: "BC",
          seller: B,
          buyer: C,
          paymentToken: token,
          amount: 200n,
          escrowReference: "funded:BC",
          ownerTransferReference: "owner:BC",
        },
      },
    ],
  };
}
function adapter(value = snapshot()): WholeReceiptReadAdapter {
  return {
    intermediaryId: "artfi",
    registrarId: value.binding.registrarId,
    oracleId: "trusted-oracle",
    readVerified: vi.fn().mockResolvedValue(value),
  };
}
function read(source?: WholeReceiptReadAdapter, viewer = A) {
  return readWholeReceiptStatus({
    asset,
    viewer,
    viewerChainId: 560048,
    signal: new AbortController().signal,
    adapter: source,
  });
}

describe("bounded receipt source lifetime", () => {
  it("does not call the trusted source for an already cancelled request", async () => {
    const source = adapter();
    const controller = new AbortController();
    controller.abort();
    expect(await readWholeReceiptStatus({ asset, viewer: A, viewerChainId: 560048, signal: controller.signal, adapter: source })).toEqual({ok:false,code:"SOURCE_INVALID"});
    expect(source.readVerified).not.toHaveBeenCalled();
  });

  it.each(["timeout", "cancel"] as const)("settles a signal-ignoring trusted source on %s", async (mode) => {
    vi.useFakeTimers();
    try {
      const source = adapter();
      const controller = new AbortController();
      let childSignal: AbortSignal | undefined;
      let finish: (value: ReturnType<typeof snapshot>) => void = () => {};
      source.readVerified = vi.fn(({signal}: Parameters<WholeReceiptReadAdapter["readVerified"]>[0]) => { childSignal=signal; return new Promise<ReturnType<typeof snapshot>>(resolve=>{finish=resolve;}); });
      let result: unknown;
      const pending=readWholeReceiptStatus({asset,viewer:A,viewerChainId:560048,signal:controller.signal,adapter:source}).then(value=>{result=value;return value;});
      if(mode === "cancel") controller.abort();
      await vi.advanceTimersByTimeAsync(mode === "timeout" ? 4001 : 0);
      expect(result).toEqual({ok:false,code:"SOURCE_UNAVAILABLE"});
      expect(childSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      finish(snapshot());
      expect(await pending).toEqual({ok:false,code:"SOURCE_UNAVAILABLE"});
    } finally { vi.useRealTimers(); }
  });

  it("cancels an unresponsive advisory source without waiting for its deadline", async () => {
    vi.useFakeTimers();
    try {
      const source=adapter();
      const controller=new AbortController();
      source.readRegistrarReference=vi.fn().mockReturnValue(new Promise(()=>{}));
      let result: unknown;
      readWholeReceiptStatus({asset,viewer:A,viewerChainId:560048,signal:controller.signal,adapter:source}).then(value=>{result=value;});
      await vi.advanceTimersByTimeAsync(0);
      expect(source.readRegistrarReference).toHaveBeenCalledOnce();
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toEqual({ok:false,code:"SOURCE_UNAVAILABLE"});
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

function confirmedSnapshot(includeD = false) {
  const evidence = (sourceId: string, reference: string) => ({
    assetId: receiptAssetKey(asset),
    sourceId,
    reference,
  });
  const events: VerifiedReceiptEvent[] = [
    ...snapshot().events,
    {
      kind: "funded",
      trade: {
        id: "CD",
        seller: C,
        buyer: D,
        paymentToken: token,
        amount: 300n,
        escrowReference: "funded:CD",
        ownerTransferReference: "owner:CD",
      },
    },
  ];
  for (const [segmentId, holder] of includeD
    ? [
        ["AB", B],
        ["BC", C],
        ["CD", D],
      ]
    : [
        ["AB", B],
        ["BC", C],
      ]) {
    events.push({
      kind: "requested",
      segmentId,
      evidence: evidence("artfi", `request:${segmentId}`),
    });
    events.push({
      kind: "registered",
      segmentId,
      holder,
      requestReference: `request:${segmentId}`,
      evidence: evidence("trusted-oracle", `registered:${segmentId}`),
    });
  }
  return { ...snapshot(), observedOwner: D, events };
}

function registryReference(holder = D) {
  return {
    assetId: receiptAssetKey(asset),
    sourceId: "external-registrar",
    holder,
    observedAt: "2026-10-12T00:01:00Z",
    reference: "reference-only:1",
  };
}

describe("verified receipt status reader", () => {
  it("keeps exact funded, requested and paid event replays idempotent after later trades", async () => {
    const value = confirmedSnapshot(true);
    value.events.push({ kind: "paid", segmentId: "AB", reference: "paid:AB" });
    const before = await read({
      ...adapter(),
      readVerified: async () => value,
    });
    const replayed = {
      ...value,
      events: [...value.events, ...structuredClone(value.events)],
    };
    expect(
      await read({ ...adapter(), readVerified: async () => replayed }),
    ).toEqual(before);
    expect(before.ok && before.segments[0].payment).toBe("seller-paid");
  });
  it("does not hide conflicting funding or payment under a repeated event reference", async () => {
    const value = confirmedSnapshot(true);
    const funded = value.events[0];
    if (funded.kind !== "funded") throw new Error("Expected funded event");
    const conflict = {
      ...value,
      events: [
        ...value.events,
        {
          ...funded,
          trade: { ...funded.trade, amount: funded.trade.amount + 1n },
        },
      ],
    };
    expect(
      await read({ ...adapter(), readVerified: async () => conflict }),
    ).toEqual({ ok: false, code: "SOURCE_INVALID" });
    value.events.push({ kind: "paid", segmentId: "AB", reference: "paid:AB" });
    value.events.push({ kind: "paid", segmentId: "BC", reference: "paid:AB" });
    expect(
      await read({ ...adapter(), readVerified: async () => value }),
    ).toEqual({ ok: false, code: "SOURCE_INVALID" });
  });
  it("returns an explicit unavailable state without a production adapter", async () => {
    expect(await read()).toEqual({
      ok: false,
      code: "SEGMENT_EVIDENCE_NOT_CONFIGURED",
    });
  });
  it("reconstructs chain state but exposes only the signed-in wallet's financial segments", async () => {
    const result = await read(adapter());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected verified result");
    expect(result.owner).toBe(C);
    expect(result.registeredHolder).toBe(A);
    expect(result.segments.map((segment) => segment.id)).toEqual(["AB"]);
    expect(result.segments[0].amount).toBe("100");
    expect(result.segments[0].payment).toBe("escrowed");
    expect(result.segments[0].paymentEligible).toBe(false);
    const middle = await read(adapter(), B);
    expect(middle.ok && middle.segments.length).toBe(2);
  });
  it("rejects asset, source role and incomplete snapshot mismatches", async () => {
    const wrongAsset = snapshot();
    wrongAsset.binding.tokenId = "2";
    expect(await read(adapter(wrongAsset))).toEqual({
      ok: false,
      code: "SOURCE_INVALID",
    });
    const wrongRole = adapter();
    expect(
      await read({ ...wrongRole, registrarId: "other-registrar" }),
    ).toEqual({ ok: false, code: "SOURCE_INVALID" });
    expect(
      await read({ ...wrongRole, oracleId: "unrecognized-oracle" }),
    ).toEqual({ ok: false, code: "SOURCE_INVALID" });
    const incomplete = adapter();
    incomplete.readVerified = vi
      .fn()
      .mockResolvedValue({ ...snapshot(), complete: false });
    expect(await read(incomplete)).toEqual({
      ok: false,
      code: "SOURCE_INVALID",
    });
    const divergent = snapshot();
    divergent.observedOwner = B;
    expect(await read(adapter(divergent))).toEqual({
      ok: false,
      code: "SOURCE_INVALID",
    });
  });
  it("supports ArtCCH as registrar without granting the intermediary its role", async () => {
    const result = await read(adapter(snapshot("artcch")));
    expect(result.ok && result.registrarId).toBe("artcch");
    expect(result.ok && result.intermediaryId).toBe("artfi");
  });
  it("does not report source errors or aborted reads as financial success", async () => {
    const failed = adapter();
    failed.readVerified = vi
      .fn()
      .mockRejectedValue(new Error("private upstream detail"));
    expect(await read(failed)).toEqual({
      ok: false,
      code: "SOURCE_UNAVAILABLE",
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await readWholeReceiptStatus({
        asset,
        viewer: A,
        viewerChainId: 560048,
        signal: controller.signal,
        adapter: adapter(),
      }),
    ).toEqual({ ok: false, code: "SOURCE_INVALID" });
  });
  it("refuses unregistered payout observations instead of displaying them as settled", async () => {
    const source = adapter();
    source.readVerified = vi.fn().mockResolvedValue({
      ...snapshot(),
      events: [
        ...snapshot().events,
        { kind: "paid", segmentId: "AB", reference: "unregistered-payment" },
      ],
    });
    expect(await read(source)).toEqual({ ok: false, code: "SOURCE_INVALID" });
  });
  it("checks the product and wallet chain before reading any adapter", async () => {
    const source = adapter();
    expect(
      await readWholeReceiptStatus({
        asset,
        viewer: A,
        viewerChainId: 1,
        signal: new AbortController().signal,
        adapter: source,
      }),
    ).toEqual({ ok: false, code: "WRONG_CHAIN" });
    expect(
      await readWholeReceiptStatus({
        asset: { ...asset, section: "fractional" },
        viewer: A,
        viewerChainId: 560048,
        signal: new AbortController().signal,
        adapter: source,
      }),
    ).toEqual({ ok: false, code: "WRONG_SECTION" });
    expect(source.readVerified).not.toHaveBeenCalled();
  });
  it("does not disclose another wallet's unpaid registration condition", async () => {
    const source = adapter();
    const evidence = (sourceId: string, reference: string) => ({
      assetId: receiptAssetKey(asset),
      sourceId,
      reference,
    });
    source.readVerified = vi.fn().mockResolvedValue({
      ...snapshot(),
      events: [
        ...snapshot().events,
        {
          kind: "requested",
          segmentId: "AB",
          evidence: evidence("artfi", "request:AB"),
        },
        {
          kind: "registered",
          segmentId: "AB",
          holder: B,
          requestReference: "request:AB",
          evidence: evidence("trusted-oracle", "registered:AB"),
        },
        {
          kind: "requested",
          segmentId: "BC",
          evidence: evidence("artfi", "request:BC"),
        },
        {
          kind: "rejected",
          segmentId: "BC",
          requestReference: "request:BC",
          evidence: evidence("trusted-oracle", "rejected:BC"),
        },
      ],
    });
    const affected = await read(source, A);
    expect(affected.ok && affected.recovery).toBe(
      "registered-payment-unresolved",
    );
    const laterBuyer = await read(source, C);
    expect(laterBuyer.ok && laterBuyer.recovery).toBe("none");
    const outsider = await read(source, `0x${"d".repeat(40)}`);
    expect(outsider.ok && outsider.recovery).toBe("none");
    expect(outsider.ok && outsider.segments).toEqual([]);
  });

  it("accepts historical C confirmation when the latest registrar holder is already D", async () => {
    const source = adapter();
    source.readVerified = vi.fn().mockResolvedValue(confirmedSnapshot());
    source.readRegistrarReference = vi
      .fn()
      .mockResolvedValue(registryReference());
    const result = await read(source, C);
    if (!result.ok) throw new Error("Historical receipt must remain valid");
    expect(result.owner).toBe(D);
    expect(result.registeredHolder).toBe(C);
    expect(result.registrarReference.status).toBe("available");
    expect(
      result.registrarReference.status === "available" &&
        result.registrarReference.value.holder,
    ).toBe(D);
    expect(result.oracleId).toBe("trusted-oracle");
    expect(result.holderComparison).toBe("not-requested");
    expect(
      result.segments.find((segment) => segment.id === "BC")?.paymentEligible,
    ).toBe(true);
  });

  it("does not require a latest-holder read and leaves opt-in verification unavailable without its record baseline", async () => {
    const source = adapter();
    source.readVerified = vi.fn().mockResolvedValue(confirmedSnapshot());
    const defaultResult = await read(source, C);
    expect(defaultResult.ok && defaultResult.holderComparison).toBe(
      "not-requested",
    );
    expect(defaultResult.ok && defaultResult.registrarReference.status).toBe(
      "not-read",
    );
    expect(
      defaultResult.ok && defaultResult.redemptionIdentityMatches,
    ).toBeNull();
    const requested = await read(
      { ...source, holderComparisonRequested: true },
      C,
    );
    expect(requested.ok && requested.holderComparison).toBe(
      "unavailable-record-baseline",
    );
    expect(
      requested.ok &&
        requested.segments.find((segment) => segment.id === "BC")
          ?.paymentEligible,
    ).toBe(true);
  });

  it("handles an exact repeated C receipt after D without regressing confirmed state", async () => {
    const value = confirmedSnapshot(true);
    const repeat = value.events.find(
      (event) => event.kind === "registered" && event.segmentId === "BC",
    )!;
    const source = adapter();
    source.readVerified = vi
      .fn()
      .mockResolvedValue({ ...value, events: [...value.events, repeat] });
    const result = await read(source, C);
    if (!result.ok) throw new Error("Exact receipt replay must be idempotent");
    expect(result.registeredHolder).toBe(D);
    expect(
      result.segments.find((segment) => segment.id === "BC")
        ?.historicalConfirmation,
    ).toBe("none");
    expect(
      result.segments.find((segment) => segment.id === "CD")?.paymentEligible,
    ).toBe(true);
  });

  it("keeps an unmatched historical receipt unprocessed without rewriting other confirmations", async () => {
    const value = confirmedSnapshot(true);
    const historical: VerifiedReceiptEvent = {
      kind: "registered",
      segmentId: "BC",
      holder: C,
      requestReference: "request:BC",
      evidence: {
        assetId: receiptAssetKey(asset),
        sourceId: "trusted-oracle",
        reference: "different-record-no-mapping",
      },
    };
    const source = adapter();
    source.readVerified = vi
      .fn()
      .mockResolvedValue({ ...value, events: [...value.events, historical] });
    const result = await read(source, C);
    if (!result.ok)
      throw new Error("Unmapped history must not discard confirmed segments");
    expect(result.registeredHolder).toBe(D);
    expect(
      result.segments.find((segment) => segment.id === "BC")
        ?.historicalConfirmation,
    ).toBe("unprocessed");
    expect(
      result.segments.find((segment) => segment.id === "CD")?.paymentEligible,
    ).toBe(true);
    source.readVerified = vi.fn().mockResolvedValue({
      ...value,
      events: [
        ...value.events,
        {
          ...historical,
          evidence: {
            ...historical.evidence,
            sourceId: "unrecognized-source",
          },
        },
      ],
    });
    expect(await read(source, C)).toEqual({
      ok: false,
      code: "SOURCE_INVALID",
    });
  });

  it("keeps trusted Oracle history and payment eligibility when registry references fail or are malformed", async () => {
    const source = adapter();
    source.readVerified = vi.fn().mockResolvedValue(confirmedSnapshot());
    for (const lookup of [
      vi.fn().mockRejectedValue(new Error("registry unavailable")),
      vi
        .fn()
        .mockResolvedValue({ ...registryReference(), holder: "malformed" }),
      vi
        .fn()
        .mockResolvedValue({ ...registryReference(), assetId: "other-asset" }),
    ]) {
      source.readRegistrarReference = lookup;
      const result = await read(
        { ...source, holderComparisonRequested: true },
        C,
      );
      if (!result.ok)
        throw new Error("Advisory lookup must not veto trusted Oracle data");
      expect(result.registeredHolder).toBe(C);
      expect(result.registrarReference.status).toBe("unavailable");
      expect(result.holderComparison).toBe("unavailable-record-baseline");
      expect(result.redemptionIdentityMatches).toBeNull();
      expect(
        result.segments.find((segment) => segment.id === "BC")?.paymentEligible,
      ).toBe(true);
    }
  });

  it("does not let an unresponsive registry reference hold trusted results open", async () => {
    vi.useFakeTimers();
    try {
      const source = adapter();
      source.readVerified = vi.fn().mockResolvedValue(confirmedSnapshot());
      source.readRegistrarReference = vi
        .fn()
        .mockReturnValue(new Promise(() => {}));
      const pending = read(source, C);
      await vi.advanceTimersByTimeAsync(2100);
      const result = await pending;
      expect(result.ok && result.registrarReference.status).toBe("unavailable");
      expect(
        result.ok &&
          result.segments.find((segment) => segment.id === "BC")
            ?.paymentEligible,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cannot replace missing trusted Oracle evidence with a direct registry lookup", async () => {
    const source = adapter();
    source.readVerified = vi
      .fn()
      .mockRejectedValue(new Error("Oracle unavailable"));
    source.readRegistrarReference = vi
      .fn()
      .mockResolvedValue(registryReference(C));
    expect(await read(source, C)).toEqual({
      ok: false,
      code: "SOURCE_UNAVAILABLE",
    });
    expect(source.readRegistrarReference).not.toHaveBeenCalled();
  });

  it("does not publish a successful snapshot after cancellation during an advisory lookup", async () => {
    const source = adapter();
    source.readVerified = vi.fn().mockResolvedValue(confirmedSnapshot());
    let finish: (value: unknown) => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    source.readRegistrarReference = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const controller = new AbortController();
    const pending = readWholeReceiptStatus({
      asset,
      viewer: C,
      viewerChainId: 560048,
      signal: controller.signal,
      adapter: source,
    });
    await ready;
    expect(source.readRegistrarReference).toHaveBeenCalledOnce();
    controller.abort();
    finish(registryReference());
    expect(await pending).toEqual({ ok: false, code: "SOURCE_UNAVAILABLE" });
  });
});
