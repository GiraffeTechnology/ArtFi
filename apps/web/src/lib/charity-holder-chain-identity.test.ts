import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";

const mocks = vi.hoisted(() => ({
  getChainId: vi.fn(),
  verifyMessage: vi.fn(),
  readContract: vi.fn(),
  create: vi.fn(),
}));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: mocks.create,
  };
});
import {
  canonicalTokenId,
  createHolderChallenge,
  createHolderGrant,
  verifyHolderOwnership,
  type OwnershipReader,
} from "./charity-holder-auth";

const holder = "0x1111111111111111111111111111111111111111" as Address;
const contract = "0x2222222222222222222222222222222222222222";
const signature = `0x${"11".repeat(65)}` as Hex;
const maximum = ((1n << 256n) - 1n).toString();
const overflow = (1n << 256n).toString();
let calls: string[];
let source: OwnershipReader;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv(
    "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
    "synthetic-test-only-holder-chain-scope-key",
  );
  vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
  vi.stubEnv("ARTFI_RPC_URL", "https://synthetic-rpc.example.invalid");
  vi.stubEnv("ARTFI_CHARITY_EDITIONS_ADDRESS", contract);
  mocks.getChainId.mockResolvedValue(560048);
  mocks.verifyMessage.mockResolvedValue(true);
  mocks.readContract.mockResolvedValue(1n);
  mocks.create.mockReturnValue({
    getChainId: mocks.getChainId,
    verifyMessage: mocks.verifyMessage,
    readContract: mocks.readContract,
  });
  calls = [];
  source = {
    getChainId: vi.fn(async () => {
      calls.push("chain");
      return 560048;
    }),
    verifyMessage: vi.fn(async () => {
      calls.push("signature");
      return true;
    }),
    balanceOf: vi.fn(async () => {
      calls.push("balance");
      return 1n;
    }),
  };
});
afterEach(() => vi.unstubAllEnvs());

describe("charity holder chain identity regression", () => {
  it("rejects a different chain before signature or balance reads", async () => {
    source.getChainId = vi.fn(async () => 1);
    expect(
      await verifyHolderOwnership(holder, "7", "message", signature, source),
    ).toBe(false);
    expect(source.verifyMessage).not.toHaveBeenCalled();
    expect(source.balanceOf).not.toHaveBeenCalled();
  });
  it("rejects a chain change while the ownership read is pending", async () => {
    source.getChainId = vi
      .fn()
      .mockResolvedValueOnce(560048)
      .mockResolvedValueOnce(1);
    expect(
      await verifyHolderOwnership(holder, "7", "message", signature, source),
    ).toBe(false);
    expect(source.balanceOf).toHaveBeenCalledExactlyOnceWith(holder, 7n);
  });
  it("does not assume a chain when the first chain read fails", async () => {
    source.getChainId = vi.fn(async () => {
      throw new Error("synthetic chain unavailable");
    });
    await expect(
      verifyHolderOwnership(holder, "7", "message", signature, source),
    ).rejects.toThrow("synthetic chain unavailable");
    expect(source.verifyMessage).not.toHaveBeenCalled();
    expect(source.balanceOf).not.toHaveBeenCalled();
  });
  it("does not retain success when the final chain read fails", async () => {
    source.getChainId = vi
      .fn()
      .mockResolvedValueOnce(560048)
      .mockRejectedValueOnce(new Error("synthetic chain unavailable"));
    await expect(
      verifyHolderOwnership(holder, "7", "message", signature, source),
    ).rejects.toThrow("synthetic chain unavailable");
  });
  it("retains a held balance and signature only within the verified chain", async () => {
    expect(
      await verifyHolderOwnership(holder, "7", "message", signature, source),
    ).toBe(true);
    expect(calls).toEqual(["chain", "signature", "balance", "chain"]);
    expect(source.verifyMessage).toHaveBeenCalledExactlyOnceWith({
      address: holder,
      message: "message",
      signature,
    });
  });
  it("rejects the first token id outside uint256 before any reader call", async () => {
    expect(canonicalTokenId(overflow)).toBeUndefined();
    expect(
      await verifyHolderOwnership(
        holder,
        overflow,
        "message",
        signature,
        source,
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
  it("refuses oversized decimal ids when issuing challenges and grants", () => {
    expect(() =>
      createHolderChallenge(holder, overflow, "https://artfi.example"),
    ).toThrow();
    expect(() => createHolderGrant(holder, overflow)).toThrow();
  });
  it("accepts the maximum uint256 with its exact balance argument", async () => {
    expect(canonicalTokenId(maximum)).toBe(maximum);
    expect(
      await verifyHolderOwnership(
        holder,
        maximum,
        "message",
        signature,
        source,
      ),
    ).toBe(true);
    expect(source.balanceOf).toHaveBeenCalledExactlyOnceWith(
      holder,
      BigInt(maximum),
    );
  });
  it("rejects a 78-digit decimal overflow instead of passing it to the ABI", () => {
    expect(canonicalTokenId("9".repeat(78))).toBeUndefined();
  });
  it("refuses malformed ids before constructing the default RPC client", async () => {
    vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "");
    expect(
      await verifyHolderOwnership(holder, "../master", "message", signature),
    ).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("checks the default RPC actual chain rather than its configured chain label", async () => {
    mocks.getChainId.mockResolvedValue(1);
    expect(await verifyHolderOwnership(holder, "7", "message", signature)).toBe(
      false,
    );
    expect(mocks.getChainId).toHaveBeenCalledOnce();
    expect(mocks.verifyMessage).not.toHaveBeenCalled();
    expect(mocks.readContract).not.toHaveBeenCalled();
  });
  it("preserves the original configured contract and balance call on Hoodi", async () => {
    expect(await verifyHolderOwnership(holder, "7", "message", signature)).toBe(
      true,
    );
    expect(mocks.getChainId).toHaveBeenCalledTimes(2);
    expect(mocks.readContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        address: contract,
        functionName: "balanceOf",
        args: [holder, 7n],
      }),
    );
  });
  it("rejects a changed actual chain after the default RPC balance read", async () => {
    mocks.getChainId
      .mockResolvedValueOnce(560048)
      .mockResolvedValueOnce(11155111);
    expect(await verifyHolderOwnership(holder, "7", "message", signature)).toBe(
      false,
    );
    expect(mocks.readContract).toHaveBeenCalledOnce();
  });
  it("still skips the balance read when wallet control is invalid", async () => {
    source.verifyMessage = vi.fn(async () => false);
    expect(
      await verifyHolderOwnership(holder, "7", "message", signature, source),
    ).toBe(false);
    expect(source.getChainId).toHaveBeenCalledOnce();
    expect(source.balanceOf).not.toHaveBeenCalled();
  });
});
