import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/nft/[action]/route";
import { NftError } from "./model";
const state = vi.hoisted(() => ({
  auth: vi.fn(),
  journal: vi.fn(),
  operation: {
    id: "isolated-operation-1",
    status: "awaiting-wallet",
    walletStarted: true,
    plan: { kind: "signature" },
  },
}));
vi.mock("../user-auth", async (original) => ({
  ...(await original<typeof import("../user-auth")>()),
  requireUserSession: state.auth,
}));
vi.mock("./journal", () => ({ nftJournal: state.journal }));
vi.mock("./engine", () => ({
  prepareNftOperation: vi.fn(),
  submitNftSignature: vi.fn(),
  recordNftTransaction: vi.fn(),
  reconcileNftOperation: vi.fn(),
  reviewNftOperation: vi.fn(),
  publicOrder: vi.fn(),
}));
const account = "0x1111111111111111111111111111111111111111";
async function post(
  action: string,
  extra: Record<string, unknown> = {},
  origin = "https://artfi.example",
) {
  return POST(
    new Request(`https://artfi.example/api/nft/${action}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        operationId: "isolated-operation-1",
        account,
        chainId: 1,
        ...extra,
      }),
    }),
    { params: Promise.resolve({ action }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  state.operation = {
    id: "isolated-operation-1",
    status: "awaiting-wallet",
    walletStarted: true,
    plan: { kind: "signature" },
  };
  state.auth.mockResolvedValue({
    session: { id: "session-1", address: account, chainId: 1 },
    accessToken: "isolated-access",
  });
  state.journal.mockImplementation(
    async (action: string, operation: unknown) =>
      action === "get" ? state.operation : operation,
  );
});
describe("NFT wallet outcome HTTP boundary", () => {
  it.each(["submitted", "pending", "accepted", "confirmed"])(
    "never lets an uncertain callback overwrite %s",
    async (status) => {
      state.operation.status = status;
      expect((await post("wallet-uncertain")).status).toBe(409);
      expect(state.journal).toHaveBeenCalledTimes(1);
    },
  );
  it("discards only an unsubmitted signature attempt", async () => {
    const response = await post("wallet-uncertain");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      walletStarted: true,
    });
    expect(state.auth).toHaveBeenCalledWith(account, 1);
  });
  it("keeps an uncertain transaction pending and disallows unsigned discard", async () => {
    state.operation.plan.kind = "transaction";
    expect(await (await post("wallet-uncertain")).json()).toMatchObject({
      status: "pending",
    });
    expect((await post("abandon")).status).toBe(409);
  });
  it("checks the session and origin before touching a durable operation", async () => {
    expect(
      (await post("wallet-uncertain", {}, "https://other.example")).status,
    ).toBe(403);
    expect(state.auth).not.toHaveBeenCalled();
    expect(state.journal).not.toHaveBeenCalled();
    state.auth.mockRejectedValue(new NftError(401, "Sign in first."));
    expect((await post("wallet-uncertain")).status).toBe(401);
    expect(state.journal).not.toHaveBeenCalled();
  });
  it("rejects unrecognized action fields before using the session", async () => {
    expect((await post("wallet-uncertain", { signature: "0x12" })).status).toBe(
      400,
    );
    expect(state.auth).not.toHaveBeenCalled();
    expect(state.journal).not.toHaveBeenCalled();
  });
});
