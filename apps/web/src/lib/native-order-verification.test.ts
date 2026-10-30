import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";
import { nativeOrderFromAuthorization } from "./native-order";
import { saleIntentTypedData } from "./whole-artwork-intent";
import { rwaCatalogFixture } from "../test/rwa-catalog-fixture";
import { verifyNativeOrderSale } from "./native-order-verification";

const catalog = vi.hoisted(() => vi.fn());
vi.mock("./rwa-catalog-server", () => ({ readRwaCatalog: catalog }));
const rpc = vi.hoisted(() => ({
  getChainId: vi.fn(),
  getBlock: vi.fn(),
  getCode: vi.fn(),
  call: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: vi.fn(() => rpc),
}));
const market = "0x1000000000000000000000000000000000000001";
const token = "0x1000000000000000000000000000000000000002";

async function fixture() {
  const signer = privateKeyToAccount(generatePrivateKey());
  const intent = {
    seller: signer.address,
    collection: token,
    tokenId: 1n,
    paymentToken: token,
    price: 2n,
    buyer: "0x0000000000000000000000000000000000000000" as const,
    salt: 1n,
    startsAt: 1000,
    endsAt: 2000,
    epoch: 0n,
  } as const;
  const signature = await signer.signTypedData(
    saleIntentTypedData(intent, { chainId: 560048, verifyingContract: market }),
  );
  const order = nativeOrderFromAuthorization(
    "whole",
    JSON.stringify({ intent, signature }, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
    market,
  );
  return { signer, order };
}

beforeEach(() => {
  catalog.mockResolvedValue({
    data: [rwaCatalogFixture()],
    total: 1,
    page: 1,
    pageSize: 2,
  });
  vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS", market);
  vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "");
  vi.stubEnv("ARTFI_RPC_URL", "");
  rpc.getChainId.mockResolvedValue(560048);
  rpc.getBlock.mockResolvedValue({ number: 100n });
  rpc.getCode.mockResolvedValue("0x6000");
  rpc.call.mockResolvedValue({ data: `0x1626ba7e${"00".repeat(28)}` });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("native order sale-signature verification", () => {
  it("refuses registry-backed receipt publication before signature or RPC verification", async () => {
    const f = await fixture();
    const asset = rwaCatalogFixture();
    asset.grounding.registryBacked = true;
    catalog.mockResolvedValue({ data: [asset], total: 1 });
    await expect(verifyNativeOrderSale(f.order)).rejects.toThrow(
      /legacy whole-artwork market/,
    );
    expect(rpc.getChainId).not.toHaveBeenCalled();
    expect(rpc.call).not.toHaveBeenCalled();
    expect(catalog.mock.calls[0][0].get("tokenId")).toBe("1");
  });
  it.each(["ambiguous", "wrong-binding", "inactive", "unavailable"])(
    "does not downgrade a %s source binding to the direct-payment path",
    async (problem) => {
      const f = await fixture();
      const asset = rwaCatalogFixture();
      if (problem === "wrong-binding") asset.binding.tokenId = "2";
      if (problem === "inactive") asset.grounding.status = "revoked";
      if (problem === "unavailable")
        catalog.mockRejectedValueOnce(new Error("Unavailable"));
      else
        catalog.mockResolvedValue({
          data: [asset],
          total: problem === "ambiguous" ? 2 : 1,
        });
      await expect(verifyNativeOrderSale(f.order)).rejects.toThrow(
        /current source binding/,
      );
      expect(rpc.getChainId).not.toHaveBeenCalled();
    },
  );
  it("admits an existing canonical EOA sale signature without requiring RPC or SIN", async () => {
    const f = await fixture();
    await expect(verifyNativeOrderSale(f.order)).resolves.toBeUndefined();
    expect(rpc.getCode).not.toHaveBeenCalled();
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });
  it("refuses an order whose seller did not sign the existing sale terms", async () => {
    const f = await fixture();
    f.order.intent.seller = privateKeyToAccount(generatePrivateKey()).address;
    await expect(verifyNativeOrderSale(f.order)).rejects.toThrow();
  });
  it("refuses another configured market before any RPC", async () => {
    const f = await fixture();
    vi.stubEnv("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS", token);
    await expect(verifyNativeOrderSale(f.order)).rejects.toThrow(
      /different market/,
    );
    expect(rpc.getCode).not.toHaveBeenCalled();
  });
  it("does not grant EOA admission to a v0/1 variant", async () => {
    const f = await fixture();
    const v = Number.parseInt(f.order.signature.slice(-2), 16) - 27;
    f.order.signature =
      `${f.order.signature.slice(0, -2)}${v.toString(16).padStart(2, "0")}` as Hex;
    await expect(verifyNativeOrderSale(f.order)).rejects.toThrow(/SIN/);
  });
  it("verifies a contract-wallet sale at one block in the existing SIN zone", async () => {
    const f = await fixture();
    vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
    vi.stubEnv("ARTFI_RPC_URL", "https://rpc.example.invalid");
    f.order.signature = "0x";
    await expect(verifyNativeOrderSale(f.order)).resolves.toBeUndefined();
    expect(rpc.call).toHaveBeenCalledTimes(1);
    for (const [input] of rpc.call.mock.calls)
      expect(input).toMatchObject({
        account: market,
        blockNumber: 100n,
        to: f.signer.address.toLowerCase(),
      });
  });
  it("closes on a wrong RPC chain or a contract-wallet rejection", async () => {
    const f = await fixture();
    vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
    vi.stubEnv("ARTFI_RPC_URL", "https://rpc.example.invalid");
    f.order.signature = "0x";
    rpc.getChainId.mockResolvedValue(1);
    await expect(verifyNativeOrderSale(f.order)).rejects.toThrow(
      /different chain/,
    );
    rpc.getChainId.mockResolvedValue(560048);
    rpc.call.mockResolvedValue({ data: `0xffffffff${"00".repeat(28)}` });
    await expect(verifyNativeOrderSale(f.order)).rejects.toThrow(/invalid/);
  });
});
