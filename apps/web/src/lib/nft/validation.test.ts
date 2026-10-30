import { nftPriceWei } from "./model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Interface, TypedDataEncoder } from "ethers";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import { EIP_712_ORDER_TYPE } from "@opensea/seaport-js/lib/constants";
import { getDefaultConduit, Chain } from "@opensea/sdk";
import { nftScopes, SEAPORT, ZERO, WETH } from "./config";
import {
  readNftRequest,
  type NftRequest,
  type NftScope,
  type NftTypedData,
} from "./model";
import {
  components,
  orderHash,
  validateComponents,
  validateTransaction,
  validateTypedData,
  type Components,
} from "./validation";
import { NftPlanRecorder, ReadOnlyNftProvider } from "./recorder";
import { safeNft, venueFetch } from "./venue";

export const account = "0x1111111111111111111111111111111111111111";
export const scope: NftScope = {
  slug: "fixture-digital",
  chain: "ethereum",
  contract: "0x2222222222222222222222222222222222222222",
  standard: "erc1155",
  label: "TEST ONLY digital fixture",
  charity: true,
};
const recipient = "0x3333333333333333333333333333333333333333";
const conduit = getDefaultConduit(Chain.Mainnet);
const now = Math.floor(Date.now() / 1000);
export function parameters(): Components {
  return {
    offerer: account,
    zone: ZERO,
    offer: [
      {
        itemType: 3,
        token: scope.contract,
        identifierOrCriteria: "7",
        startAmount: "10",
        endAmount: "10",
      },
    ],
    consideration: [
      {
        itemType: 0,
        token: ZERO,
        identifierOrCriteria: "0",
        startAmount: "9750",
        endAmount: "9750",
        recipient: account,
      },
      {
        itemType: 0,
        token: ZERO,
        identifierOrCriteria: "0",
        startAmount: "250",
        endAmount: "250",
        recipient,
      },
    ],
    orderType: 1,
    startTime: String(now - 30),
    endTime: String(now + 3600),
    zoneHash: `0x${"0".repeat(64)}`,
    salt: "1",
    conduitKey: conduit.key,
    counter: "0",
  };
}
export function input(action: NftRequest["action"] = "list"): NftRequest {
  return {
    action,
    collection: scope.slug,
    tokenId: "7",
    account,
    quantity: "10",
    priceWei: "10000",
    expiresAt: now + 3600,
    ...(["buy", "accept", "cancel"].includes(action)
      ? { orderHash: orderHash(parameters()) }
      : {}),
  };
}
const abi = new Interface(SeaportABI);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("NFT request and collection boundary", () => {
  it("keeps only explicitly configured digital collection identity", () => {
    vi.stubEnv("ARTFI_NFT_COLLECTIONS_JSON", JSON.stringify([scope]));
    expect(nftScopes()).toEqual([scope]);
    vi.stubEnv("ARTFI_NFT_COLLECTIONS_JSON", JSON.stringify([scope, scope]));
    expect(() => nftScopes()).toThrow();
  });
  it.each([
    { chain: "hoodi" },
    { charity: undefined },
    { contract: ZERO },
    { slug: "../bad" },
    { privateKey: "not-allowed" },
  ])("rejects invalid configuration %j", (value) => {
    vi.stubEnv(
      "ARTFI_NFT_COLLECTIONS_JSON",
      JSON.stringify([{ ...scope, ...value }]),
    );
    expect(() => nftScopes()).toThrow();
  });
  it("validates quantities, unknown fields, expiry and canonical order identity", () => {
    expect(readNftRequest(input())).toEqual(input());
    for (const patch of [
      { quantity: "0" },
      { quantity: "1e3" },
      { quantity: "1000001" },
      { priceWei: "-1" },
      { expiresAt: 0 },
      { privateKey: "no" },
      { tokenId: "0x7" },
    ])
      expect(() => readNftRequest({ ...input(), ...patch })).toThrow();
    expect(() =>
      readNftRequest({ ...input("buy"), orderHash: "no" }),
    ).toThrow();
  });
  it("drops all artwork previews and unknown metadata from public results", () => {
    const nft = safeNft(
      {
        contract: scope.contract,
        collection: scope.slug,
        identifier: "7",
        tokenStandard: "erc1155",
        name: "Fixture",
        imageUrl: "https://private.test/master",
        metadataUrl: "https://private.test/master",
      },
      scope,
    );
    expect(nft).not.toHaveProperty("imageUrl");
    expect(nft).not.toHaveProperty("metadataUrl");
    expect(() =>
      safeNft({ ...nft, tokenStandard: "erc721", identifier: "7" }, scope),
    ).toThrow();
  });
});
describe("Seaport review binding", () => {
  it("accepts exact fixed-price listing, fees, and bounded integral partial fill", () => {
    expect(validateComponents(parameters(), input(), scope, true).total).toBe(
      10000n,
    );
    expect(
      validateComponents(
        parameters(),
        { ...input("buy"), quantity: "2", priceWei: "2000" },
        scope,
        false,
      ).total,
    ).toBe(2000n);
  });
  it.each([
    "offerer",
    "zone",
    "asset",
    "tokenId",
    "amount",
    "expiry",
    "recipient",
    "currency",
    "conduit",
  ])("rejects altered %s", (field) => {
    const p = parameters();
    if (field === "offerer") p.offerer = recipient;
    if (field === "zone") p.zone = recipient;
    if (field === "asset") p.offer[0].token = recipient;
    if (field === "tokenId") p.offer[0].identifierOrCriteria = "8";
    if (field === "amount")
      p.consideration[0].startAmount = p.consideration[0].endAmount = "20000";
    if (field === "expiry") p.endTime = "1";
    if (field === "recipient") p.consideration[0].recipient = recipient;
    if (field === "currency") p.consideration[0].token = WETH.ethereum;
    if (field === "conduit") p.conduitKey = `0x${"7".repeat(64)}`;
    expect(() => validateComponents(p, input(), scope, true)).toThrow();
  });
  it("rejects missing consideration recipient and unsupported criteria", () => {
    const p = parameters();
    delete p.consideration[0].recipient;
    expect(() => components(p)).toThrow();
    p.offer[0].itemType = 5;
    expect(() => components(p)).toThrow();
  });
  it("rejects partial fills of full-only orders and non-integral offer fees", () => {
    const p = parameters();
    p.orderType = 0;
    expect(() =>
      validateComponents(
        p,
        { ...input("buy"), quantity: "2", priceWei: "2000" },
        scope,
        false,
      ),
    ).toThrow("partial fills");
    p.orderType = 1;
    const nft = p.offer[0];
    p.offer = [
      {
        itemType: 1,
        token: WETH.ethereum,
        identifierOrCriteria: "0",
        startAmount: "10000",
        endAmount: "10000",
      },
    ];
    p.consideration = [
      { ...nft, recipient: account },
      { ...p.offer[0], startAmount: "251", endAmount: "251", recipient },
    ];
    expect(() =>
      validateComponents(
        p,
        { ...input("accept"), quantity: "2", priceWei: "2000" },
        scope,
        false,
      ),
    ).toThrow("rounding");
  });
  it.each(["fulfillOrder", "fulfillAdvancedOrder"])(
    "binds original signed consideration count for %s",
    (method) => {
      const p = parameters();
      const parametersWithCount = { ...p, totalOriginalConsiderationItems: 1 };
      const args =
        method === "fulfillOrder"
          ? [
              { parameters: parametersWithCount, signature: "0x12" },
              conduit.key,
            ]
          : [
              {
                parameters: parametersWithCount,
                numerator: 1n,
                denominator: 1n,
                signature: "0x12",
                extraData: "0x",
              },
              [],
              conduit.key,
              account,
            ];
      const tx = {
        to: SEAPORT as `0x${string}`,
        data: abi.encodeFunctionData(method, args) as `0x${string}`,
        value: "10000",
      };
      expect(() => validateTransaction(tx, input("buy"), scope, p)).toThrow(
        "consideration count",
      );
    },
  );
  it("allows an independently approved fulfiller conduit when the maker uses direct Seaport", () => {
    const p = { ...parameters(), conduitKey: `0x${"0".repeat(64)}` };
    const tx = {
      to: SEAPORT as `0x${string}`,
      data: abi.encodeFunctionData("fulfillOrder", [
        {
          parameters: {
            ...p,
            totalOriginalConsiderationItems: p.consideration.length,
          },
          signature: "0x12",
        },
        conduit.key,
      ]) as `0x${string}`,
      value: "10000",
    };
    expect(() => validateTransaction(tx, input("buy"), scope, p)).not.toThrow();
  });
  it("binds the original fee count in basic fulfillment", () => {
    const p = parameters();
    const basic = {
      considerationToken: ZERO,
      considerationIdentifier: 0n,
      considerationAmount: 9750n,
      offerer: account,
      zone: ZERO,
      offerToken: scope.contract,
      offerIdentifier: 7n,
      offerAmount: 10n,
      basicOrderType: 5,
      startTime: p.startTime,
      endTime: p.endTime,
      zoneHash: p.zoneHash,
      salt: p.salt,
      offererConduitKey: p.conduitKey,
      fulfillerConduitKey: conduit.key,
      totalOriginalAdditionalRecipients: 1n,
      additionalRecipients: [{ amount: 250n, recipient }],
      signature: "0x12",
    };
    const tx = (count: bigint) => ({
      to: SEAPORT as `0x${string}`,
      data: abi.encodeFunctionData("fulfillBasicOrder", [
        { ...basic, totalOriginalAdditionalRecipients: count },
      ]) as `0x${string}`,
      value: "10000",
    });
    expect(() =>
      validateTransaction(tx(1n), input("buy"), scope, p),
    ).not.toThrow();
    expect(() => validateTransaction(tx(0n), input("buy"), scope, p)).toThrow(
      "selected terms",
    );
  });
  it("binds typed data to the exact standard and chain", () => {
    const typed: NftTypedData = {
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: SEAPORT,
      },
      types: EIP_712_ORDER_TYPE,
      primaryType: "OrderComponents",
      message: parameters() as unknown as Record<string, unknown>,
    };
    expect(orderHash(validateTypedData(typed, input(), scope))).toBe(
      TypedDataEncoder.hashStruct(
        "OrderComponents",
        EIP_712_ORDER_TYPE,
        parameters(),
      ),
    );
    expect(() =>
      validateTypedData(
        { ...typed, domain: { ...typed.domain, chainId: 8453 } },
        input(),
        scope,
      ),
    ).toThrow();
    expect(() =>
      validateTypedData(
        {
          ...typed,
          types: { ...typed.types, Other: [{ name: "bad", type: "uint256" }] },
        },
        input(),
        scope,
      ),
    ).toThrow();
  });
  it("narrows NFT and WETH approvals and rejects unrelated transfers", () => {
    const approvals = new Interface([
      "function setApprovalForAll(address,bool)",
      "function approve(address,uint256)",
    ]);
    const tx = {
      to: scope.contract,
      data: approvals.encodeFunctionData("setApprovalForAll", [
        conduit.address,
        true,
      ]) as `0x${string}`,
      value: "0",
    };
    expect(validateTransaction(tx, input(), scope)).toEqual(tx);
    const single = { ...scope, standard: "erc721" as const };
    const narrowed = validateTransaction(tx, input(), single);
    expect(approvals.parseTransaction({ data: narrowed.data })?.args[1]).toBe(
      7n,
    );
    expect(() =>
      validateTransaction({ ...tx, value: "1" }, input(), scope),
    ).toThrow();
    expect(() =>
      validateTransaction({ ...tx, to: recipient }, input(), scope),
    ).toThrow();
    const weth = {
      to: WETH.ethereum as `0x${string}`,
      data: approvals.encodeFunctionData("approve", [
        conduit.address,
        (1n << 256n) - 1n,
      ]) as `0x${string}`,
      value: "0",
    };
    expect(
      approvals.parseTransaction({
        data: validateTransaction(weth, input("offer"), scope).data,
      })?.args[1],
    ).toBe(10000n);
  });
  it("accepts one bound cancellation and rejects a second order", () => {
    const p = parameters();
    const tx = {
      to: SEAPORT as `0x${string}`,
      data: abi.encodeFunctionData("cancel", [[p]]) as `0x${string}`,
      value: "0",
    };
    expect(validateTransaction(tx, input("cancel"), scope, p)).toEqual(tx);
    expect(() =>
      validateTransaction(
        {
          ...tx,
          data: abi.encodeFunctionData("cancel", [
            [p, { ...p, salt: "2" }],
          ]) as `0x${string}`,
        },
        input("cancel"),
        scope,
        p,
      ),
    ).toThrow();
  });
  it("rejects changed settlement amount, recipient, order and fractional ratio", () => {
    const p = parameters();
    const make = (
      recipientAddress: string,
      numerator = 2n,
      denominator = 10n,
      terms = p,
    ) => ({
      to: SEAPORT as `0x${string}`,
      data: abi.encodeFunctionData("fulfillAdvancedOrder", [
        {
          parameters: { ...terms, totalOriginalConsiderationItems: 2 },
          numerator,
          denominator,
          signature: "0x12",
          extraData: "0x",
        },
        [],
        conduit.key,
        recipientAddress,
      ]) as `0x${string}`,
      value: "2000",
    });
    const req = { ...input("buy"), quantity: "2", priceWei: "2000" };
    expect(validateTransaction(make(account), req, scope, p)).toMatchObject({
      value: "2000",
    });
    for (const tx of [
      make(recipient),
      make(account, 3n),
      make(account, 0n, 0n),
      make(account, 2n, 10n, { ...p, salt: "2" }),
      { ...make(account), value: "2001" },
    ])
      expect(() => validateTransaction(tx, req, scope, p)).toThrow();
  });
});
describe("durable typed-data normalization", () => {
  it("accepts reordered JSON object keys while preserving typed field order", () => {
    const source: NftTypedData = {
      domain: {
        name: "Seaport",
        version: "1.6",
        chainId: 1,
        verifyingContract: SEAPORT,
      },
      types: EIP_712_ORDER_TYPE,
      primaryType: "OrderComponents",
      message: parameters() as unknown as Record<string, unknown>,
    };
    function sorted(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(sorted);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, sorted(item)]),
        );
      return value;
    }
    expect(() =>
      validateTypedData(sorted(source) as NftTypedData, input(), scope),
    ).not.toThrow();
  });
});
describe("SDK keyless planning and upstream safety", () => {
  it("captures exactly one wallet transaction without broadcasting", async () => {
    const recorder = new NftPlanRecorder(account, null);
    await expect(
      recorder.sendTransaction({
        to: scope.contract,
        data: "0x1234",
        value: 0n,
      }),
    ).rejects.toThrow("review");
    expect(recorder.captured).toEqual({
      transaction: { to: scope.contract, data: "0x1234", value: "0" },
    });
    await expect(
      recorder.sendTransaction({ to: scope.contract, data: "0x5678" }),
    ).rejects.toThrow("already");
    await expect(recorder.signMessage()).rejects.toThrow("prohibited");
    await expect(recorder.signTransaction()).rejects.toThrow("prohibited");
  });
  it.each([
    "eth_sendTransaction",
    "eth_sendRawTransaction",
    "personal_sign",
    "eth_signTypedData_v4",
    "wallet_switchEthereumChain",
  ])("blocks server RPC method %s", async (method) => {
    const rpc = new ReadOnlyNftProvider("http://127.0.0.1:1");
    try {
      await expect(rpc.send(method, [])).rejects.toThrow("prohibited");
    } finally {
      rpc.destroy();
    }
  });
  it("never follows venue redirects and blocks unexpected destinations and prepare writes", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await venueFetch("read")("https://api.opensea.io/api/v2/chains", {});
    expect(fetcher).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
    await expect(
      venueFetch("read")("https://attacker.test/api/v2/chains", {}),
    ).rejects.toThrow();
    await expect(
      venueFetch("prepare")(
        "https://api.opensea.io/api/v2/orders/ethereum/seaport/listings",
        { method: "POST" },
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 429, 500])(
    "bounds upstream %i responses without leaking bodies",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        async () => new Response("secret upstream body", { status }),
      );
      await expect(
        venueFetch("read")("https://api.opensea.io/api/v2/chains", {}),
      ).rejects.not.toThrow("secret");
    },
  );
});

describe("exact user-entered NFT prices", () => {
  it("preserves all 18 decimals without floating point", () =>
    expect(nftPriceWei("9007199254740993.123456789123456789")).toBe(
      "9007199254740993123456789123456789",
    ));
  it.each([
    "0",
    "-1",
    "01",
    "1e6",
    ".1",
    "1.0000000000000000001",
    " 1",
    String(1n << 256n),
  ])("rejects invalid or rounded price %s", (value) =>
    expect(() => nftPriceWei(value)).toThrow(),
  );
});
