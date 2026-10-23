import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { matchWholeReceiptSettlement } from "./whole-receipt-correspondence";
import { readWholeReceiptOracleObservation } from "./oracle-read";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("existing Oracle settlement/history read transport", () => {
  function transport(historyMutation?: (history: Record<string, unknown>) => void) {
    const input = fixture();
    const history = { binding: { assetId: input.journalBinding.assetId, ...input.journalBinding.token }, history: [input.certificate] };
    historyMutation?.(history);
    vi.stubEnv("ARTFI_ORACLE_READ_API_URL", "https://oracle.example/bridge/");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({settlement: input.settlement})).mockResolvedValueOnce(Response.json(history));
    vi.stubGlobal("fetch", fetcher);
    return { input, fetcher };
  }
  it("reads exact historical SUPERSEDED evidence without requesting a latest holder or exposing private binding", async () => {
    const {input, fetcher} = transport();
    const result = await readWholeReceiptOracleObservation(input.journalBinding);
    expect(result.correspondence.registrationConfirmed).toBe(true);
    expect(result.correspondence.financialExecutionAuthorized).toBe(false);
    expect(result.sourceAuthenticatedForPayment).toBe(false);
    expect(String(fetcher.mock.calls[0][0])).toBe(`https://oracle.example/bridge/v1/rwa/settlements/${input.journalBinding.settlementId}`);
    expect(String(fetcher.mock.calls[1][0])).toContain("/certificate-history");
    for (const call of fetcher.mock.calls) {
      expect(call[1]).toMatchObject({method:"GET", credentials:"omit", redirect:"error", cache:"no-store"});
      expect(JSON.stringify(call)).not.toContain(input.journalBinding.sellerWallet);
      expect(JSON.stringify(call)).not.toContain(input.journalBinding.externalExecutionRef);
    }
  });
  for (const variant of ["missing", "duplicate", "wrong-token", "revoked"] as const) {
    it(`rejects ${variant} history`, async () => {
      const {input} = transport(h => {
        const list = h.history as ReturnType<typeof fixture>["certificate"][];
        if (variant === "missing") list.splice(0);
        if (variant === "duplicate") list.push(structuredClone(list[0]));
        if (variant === "wrong-token") (h.binding as {tokenId: string}).tokenId = "8";
        if (variant === "revoked") list[0].status = "REVOKED";
      });
      await expect(readWholeReceiptOracleObservation(input.journalBinding)).rejects.toThrow();
    });
  }
  it("rejects path manipulation before any network read", async () => {
    const {input, fetcher} = transport();
    input.journalBinding.settlementId = "../../../other";
    await expect(readWholeReceiptOracleObservation(input.journalBinding)).rejects.toThrow("SETTLEMENT_READ_BINDING_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not convert upstream failure into registration or financial authorization", async () => {
    const {input, fetcher} = transport();
    fetcher.mockReset().mockResolvedValue(Response.json({}, {status:503}));
    await expect(readWholeReceiptOracleObservation(input.journalBinding)).rejects.toThrow("ORACLE_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function fixture() {
  const journal = {
    settlementId: "TEST_ONLY_NO_REAL_VALUE-segment-ab",
    assetId: "TEST_ONLY_NO_REAL_VALUE-artwork",
    token: { chainId: "560048", contract: `0x${"1".repeat(40)}`, tokenId: "7" },
    sellerWallet: `0x${"a".repeat(40)}`,
    buyerWallet: `0x${"b".repeat(40)}`,
    externalExecutionRef: "TEST_ONLY_NO_REAL_VALUE:journal/<segment-ab>",
    oldCertificateHash: "1".repeat(64),
    warehouseReceiptHash: "2".repeat(64),
    snapshotHash: "",
  };
  const settlement = {
    settlementId: journal.settlementId,
    assetId: journal.assetId,
    token: journal.token,
    snapshotHash: "",
    oldCertificateHash: journal.oldCertificateHash,
    warehouseReceiptHash: journal.warehouseReceiptHash,
    deadlineAt: "2026-10-16T12:00:00.000Z",
    businessCalendarRef: "TEST_ONLY_NO_REAL_VALUE-calendar",
    targetBusinessDays: 4,
    startedAt: "2026-10-12T12:00:00.000Z",
    status: "FINALIZED",
    registryChangeRef: "TEST_ONLY_NO_REAL_VALUE-change-ab",
    newCertificateHash: "3".repeat(64),
    finalizedAt: "2026-10-13T12:00:00.000Z",
  };
  // Alphabetical property order is the pinned Oracle canonical-json contract.
  // The '<' value deliberately distinguishes it from the Go journal wire hash.
  journal.snapshotHash = settlement.snapshotHash = createHash("sha256")
    .update(
      JSON.stringify({
        assetId: journal.assetId,
        businessCalendarRef: settlement.businessCalendarRef,
        buyerWallet: journal.buyerWallet,
        deadlineAt: settlement.deadlineAt,
        externalExecutionRef: journal.externalExecutionRef,
        observedAt: settlement.startedAt,
        oldCertificateHash: journal.oldCertificateHash,
        schemaVersion: "giraffe-settlement-snapshot.v1",
        sellerWallet: journal.sellerWallet,
        settlementId: journal.settlementId,
        targetBusinessDays: settlement.targetBusinessDays,
        token: journal.token,
        warehouseReceiptHash: journal.warehouseReceiptHash,
      }),
    )
    .digest("hex");
  const certificate = {
    assetId: journal.assetId,
    tokenId: journal.token.tokenId,
    certificateVersion: 2,
    certificateHash: settlement.newCertificateHash,
    previousCertificateHash: journal.oldCertificateHash,
    wenbaoChangeRef: settlement.registryChangeRef,
    warehouseReceiptHash: journal.warehouseReceiptHash,
    effectiveAt: settlement.finalizedAt,
    status: "SUPERSEDED",
    settlementId: journal.settlementId,
    settlementSnapshotHash: journal.snapshotHash,
  };
  return { journalBinding: journal, settlement, certificate };
}

describe("whole receipt existing Oracle correspondence", () => {
  it("binds hidden participants/execution ref using the existing snapshot and preserves historical evidence", () => {
    const input = fixture();
    const first = matchWholeReceiptSettlement(input);
    expect(first.registrationConfirmed).toBe(true);
    expect(first.financialExecutionAuthorized).toBe(false);
    expect(matchWholeReceiptSettlement(structuredClone(input))).toEqual(first);
    expect(JSON.stringify(first)).not.toContain(
      input.journalBinding.buyerWallet,
    );
    expect(JSON.stringify(first)).not.toContain(
      input.journalBinding.externalExecutionRef,
    );
  });
  for (const field of [
    "sellerWallet",
    "buyerWallet",
    "externalExecutionRef",
  ] as const) {
    it(`rejects authenticated-journal ${field} substitution despite unchanged public settlement ID`, () => {
      const input = fixture();
      input.journalBinding[field] =
        field === "externalExecutionRef"
          ? "another-segment"
          : `0x${"c".repeat(40)}`;
      expect(() => matchWholeReceiptSettlement(input)).toThrow(
        "SETTLEMENT_PRIVATE_CORRESPONDENCE_MISMATCH",
      );
    });
  }
  for (const field of [
    "settlementId",
    "assetId",
    "snapshotHash",
    "oldCertificateHash",
    "warehouseReceiptHash",
  ] as const) {
    it(`rejects ${field} cross-segment substitution`, () => {
      const input = fixture();
      input.settlement[field] = field.endsWith("Hash")
        ? "4".repeat(64)
        : "another-record";
      expect(() => matchWholeReceiptSettlement(input)).toThrow(
        "SETTLEMENT_JOURNAL_BINDING_MISMATCH",
      );
    });
  }
  for (const field of ["chainId", "contract", "tokenId"] as const) {
    it(`rejects a different ${field}`, () => {
      const input = structuredClone(fixture());
      input.settlement.token = {
        ...input.settlement.token,
        [field]: "another-token",
      };
      expect(() => matchWholeReceiptSettlement(input)).toThrow(
        "SETTLEMENT_TOKEN_BINDING_MISMATCH",
      );
    });
  }
  for (const field of [
    "certificateHash",
    "previousCertificateHash",
    "warehouseReceiptHash",
    "settlementSnapshotHash",
    "assetId",
    "tokenId",
    "wenbaoChangeRef",
    "settlementId",
    "status",
  ] as const) {
    it(`rejects certificate ${field} mismatch or revocation`, () => {
      const input = fixture();
      input.certificate[field] =
        field === "status"
          ? "REVOKED"
          : field.endsWith("Hash")
            ? "5".repeat(64)
            : "another-record";
      expect(() => matchWholeReceiptSettlement(input)).toThrow();
    });
  }
  it("does not reinterpret cancellation as registration rejection, refund, or rollback authorization", () => {
    const input = fixture();
    const common = Object.fromEntries(
      Object.entries(input.settlement).filter(
        ([key]) =>
          !["registryChangeRef", "newCertificateHash", "finalizedAt"].includes(
            key,
          ),
      ),
    );
    for (const [status, timeKey] of [
      ["PENDING", undefined],
      ["CANCELLED", "cancelledAt"],
      ["DISPUTED", "disputedAt"],
      ["TIMED_OUT", "timedOutAt"],
    ] as const) {
      const settlement = {
        ...common,
        status,
        ...(timeKey
          ? {
              [timeKey]: "2026-10-17T12:00:00.000Z",
              failureReasonHash: "6".repeat(64),
            }
          : {}),
      };
      expect(
        matchWholeReceiptSettlement({ ...input, settlement }),
      ).toMatchObject({
        status,
        registrationConfirmed: false,
        financialExecutionAuthorized: false,
      });
    }
  });
  it("rejects missing certificate, bare VALID status, foreign fields and late finalization", () => {
    const input = fixture();
    expect(() =>
      matchWholeReceiptSettlement({ ...input, certificate: undefined }),
    ).toThrow();
    expect(() =>
      matchWholeReceiptSettlement({
        ...input,
        settlement: {
          settlementId: input.settlement.settlementId,
          status: "VALID",
        },
      }),
    ).toThrow();
    expect(() =>
      matchWholeReceiptSettlement({
        ...input,
        settlement: {
          ...input.settlement,
          buyerWallet: input.journalBinding.buyerWallet,
        },
      }),
    ).toThrow();
    expect(() =>
      matchWholeReceiptSettlement({
        ...input,
        settlement: {
          ...input.settlement,
          finalizedAt: "2026-10-17T12:00:00.000Z",
        },
      }),
    ).toThrow("SETTLEMENT_TIME_INVALID");
  });
});
