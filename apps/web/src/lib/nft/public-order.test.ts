import { describe, expect, it } from "vitest";
import { publicOrder } from "./engine";
import { components, orderHash, type Components } from "./validation";
import { ZERO, WETH } from "./config";
import type { NftScope } from "./model";
const maker = "0x1111111111111111111111111111111111111111",
  contract = "0x2222222222222222222222222222222222222222",
  fee = "0x3333333333333333333333333333333333333333";
const scope: NftScope = {
  slug: "test-only-order",
  chain: "ethereum",
  contract,
  standard: "erc1155",
  label: "TEST_ONLY",
  charity: false,
};
function parameters(
  side: "listing" | "offer" = "listing",
  standard: "erc721" | "erc1155" = "erc1155",
): Components {
  const nft = {
    itemType: standard === "erc721" ? 2 : 3,
    token: contract,
    identifierOrCriteria: "7",
    startAmount: standard === "erc721" ? "1" : "10",
    endAmount: standard === "erc721" ? "1" : "10",
  };
  const pay = {
    itemType: side === "listing" ? 0 : 1,
    token: side === "listing" ? ZERO : WETH.ethereum,
    identifierOrCriteria: "0",
    startAmount: "10000",
    endAmount: "10000",
  };
  return {
    offerer: maker,
    zone: ZERO,
    offer: [side === "listing" ? nft : pay],
    consideration:
      side === "listing"
        ? [{ ...pay, recipient: maker }]
        : [{ ...nft, recipient: maker }],
    orderType: 1,
    startTime: "100",
    endTime: "2000000000",
    zoneHash: "0x" + "00".repeat(32),
    salt: "1",
    conduitKey: "0x" + "00".repeat(32),
    counter: "0",
  };
}
const raw = (p: Components) => ({
  protocolData: { parameters: p },
  status: "observed",
});
describe("native order detail identity and exact display amounts", () => {
  it.each(["asset-standard", "erc721-size", "unsafe-expiry"])(
    "order-display regression: omits %s",
    (field) => {
      const p = parameters();
      let selected = scope;
      if (field === "asset-standard") p.offer[0]!.itemType = 1;
      if (field === "erc721-size") {
        selected = { ...scope, standard: "erc721" };
        p.offer[0]!.itemType = 2;
      }
      if (field === "unsafe-expiry") p.endTime = "9007199254740993";
      expect(publicOrder(raw(p), selected, "7", "listing")).toBeNull();
    },
  );
  it.each(["listing", "offer"] as const)(
    "retains canonical %s identities without claiming live availability",
    (side) => {
      const p = parameters(side),
        out = publicOrder(raw(p), scope, "7", side);
      expect(out).toEqual({
        hash: orderHash(components(p)),
        side,
        maker,
        quantity: "10",
        priceWei: "10000",
        currency: side === "listing" ? "ETH" : "WETH",
        expiresAt: 2000000000,
        status: "observed",
      });
    },
  );
  it.each(["listing", "offer"] as const)(
    "accepts an exact single ERC721 %s",
    (side) => {
      const p = parameters(side, "erc721");
      expect(
        publicOrder(raw(p), { ...scope, standard: "erc721" }, "7", side)
          ?.quantity,
      ).toBe("1");
    },
  );
  it.each([
    "date-overflow",
    "invalid-window",
    "zero-window",
    "price-overflow",
    "wrong-token",
    "wrong-contract",
    "dynamic-price",
    "wrong-currency",
    "wrong-payment-id",
  ])("omits unsupported %s without rounding or coercion", (field) => {
    const p = parameters();
    if (field === "date-overflow") p.endTime = "8640000000001";
    if (field === "invalid-window") p.endTime = "99";
    if (field === "zero-window") p.endTime = p.startTime;
    if (field === "price-overflow") {
      p.consideration[0]!.startAmount = ((1n << 256n) - 1n).toString();
      p.consideration[0]!.endAmount = p.consideration[0]!.startAmount;
      p.consideration.push({
        ...p.consideration[0]!,
        startAmount: "1",
        endAmount: "1",
        recipient: fee,
      });
    }
    if (field === "wrong-token") p.offer[0]!.identifierOrCriteria = "8";
    if (field === "wrong-contract") p.offer[0]!.token = fee;
    if (field === "dynamic-price") p.consideration[0]!.endAmount = "10001";
    if (field === "wrong-currency") p.consideration[0]!.token = fee;
    if (field === "wrong-payment-id")
      p.consideration[0]!.identifierOrCriteria = "1";
    expect(publicOrder(raw(p), scope, "7", "listing")).toBeNull();
  });
  it("retains exact uint256 price boundary, fees and attributed source", () => {
    const p = parameters(),
      max = ((1n << 256n) - 1n).toString();
    p.consideration[0]!.startAmount = ((1n << 256n) - 2n).toString();
    p.consideration[0]!.endAmount = p.consideration[0]!.startAmount;
    p.consideration.push({
      ...p.consideration[0]!,
      startAmount: "1",
      endAmount: "1",
      recipient: fee,
    });
    const source = "https://opensea.io/assets/ethereum/" + contract + "/7";
    expect(publicOrder(raw(p), scope, "7", "listing", source)).toMatchObject({
      priceWei: max,
      sourceURL: source,
    });
  });
  it("retains the exact largest Date-representable expiry", () => {
    const p = parameters();
    p.endTime = "8640000000000";
    expect(publicOrder(raw(p), scope, "7", "listing")?.expiresAt).toBe(
      8640000000000,
    );
  });
  it("retains an expired observed order as recorded data rather than inventing availability", () => {
    const p = parameters();
    p.startTime = "1";
    p.endTime = "2";
    expect(publicOrder(raw(p), scope, "7", "listing")).toMatchObject({
      expiresAt: 2,
      status: "observed",
    });
  });
  it("does not mutate SDK parameters while producing a view", () => {
    const p = parameters(),
      before = structuredClone(p);
    publicOrder(raw(p), scope, "7", "listing");
    expect(p).toEqual(before);
  });
  it.each([null, {}, "invalid"].map((value) => ({ value })))(
    "omits malformed native order $value",
    ({ value }) => {
      expect(publicOrder(value, scope, "7", "listing")).toBeNull();
    },
  );
});
