import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interface, Wallet } from "ethers";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import { getDefaultConduit, Chain } from "@opensea/sdk";
import { prepareNftOperation, submitNftSignature } from "./engine";
import { orderHash, components } from "./validation";
import { SEAPORT } from "./config";
import { NftError, type NftScope, type NftRequest } from "./model";
import type { NftOperation } from "./journal";
import type { UserSession } from "../user-auth";
const state = vi.hoisted(() => ({
  operations: new Map<string, unknown>(),
  order: null as null | Record<string, unknown>,
  recipient: "0x1111111111111111111111111111111111111111",
  rpcMethods: [] as string[],
  calls: [] as string[],
  code: "0x",
  valid1271: false,
  submitStatus: 200,
  wrongSubmitHash: false,
  submitted: [] as unknown[],
  journalStatuses: [] as string[],
  approved: true,
  tokenApproved: false,
  standard: "erc1155",
  balance: 1000000n,
  owner: "0x1111111111111111111111111111111111111111",
}));
vi.mock("./journal", async (original) => ({
  ...(await original<typeof import("./journal")>()),
  nftJournal: async (action: string, operation: NftOperation) => {
    if (action === "get") {
      if (!state.operations.has(operation.id))
        throw new NftError(404, "missing");
      return state.operations.get(operation.id);
    }
    state.journalStatuses.push(operation.status);
    state.operations.set(operation.id, structuredClone(operation));
    return operation;
  },
}));
vi.mock("./recorder", async (original) => {
  const actual = await original<typeof import("./recorder")>();
  const { Interface, Network } = await import("ethers");
  const { SeaportABI } = await import("@opensea/seaport-js/lib/abi/Seaport");
  const abi = new Interface([
    ...SeaportABI,
    "function balanceOf(address) view returns(uint256)",
    "function balanceOf(address,uint256) view returns(uint256)",
    "function ownerOf(uint256) view returns(address)",
    "function isApprovedForAll(address,address) view returns(bool)",
    "function getApproved(uint256) view returns(address)",
    "function allowance(address,address) view returns(uint256)",
    "function decimals() view returns(uint8)",
    "function isValidSignature(bytes32,bytes) view returns(bytes4)",
  ]);
  return {
    ...actual,
    ReadOnlyNftProvider: class extends actual.ReadOnlyNftProvider {
      override async getNetwork() {
        return Network.from(1);
      }
      override async send(
        method: string,
        args: Array<unknown> | Record<string, unknown>,
      ): Promise<unknown> {
        state.rpcMethods.push(method);
        const params = args as unknown[];
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBalance") return "0x10000000000000000000000";
        if (method === "eth_getCode") return state.code;
        if (method === "eth_blockNumber") return "0x64";
        if (method === "eth_getBlockByNumber")
          return {
            number: "0x64",
            hash: `0x${"1".repeat(64)}`,
            parentHash: `0x${"2".repeat(64)}`,
            timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
            nonce: "0x0000000000000000",
            difficulty: "0x0",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            miner: "0x1111111111111111111111111111111111111111",
            extraData: "0x",
            transactions: [],
            baseFeePerGas: "0x1",
          };
        if (method === "eth_call") {
          const tx = params[0] as { data: string };
          const call = abi.parseTransaction({ data: tx.data });
          if (!call) throw new Error("Unknown fixture call");
          const values: Record<string, unknown[]> = {
            getCounter: [0n],
            getOrderStatus: [false, false, 0n, 0n],
            balanceOf: [state.balance],
            ownerOf: [state.owner],
            isApprovedForAll: [state.approved],
            getApproved: [
              state.tokenApproved
                ? getDefaultConduit(Chain.Mainnet).address
                : "0x0000000000000000000000000000000000000000",
            ],
            allowance: [state.approved ? 10n ** 30n : 0n],
            decimals: [18],
            isValidSignature: [state.valid1271 ? "0x1626ba7e" : "0xffffffff"],
          };
          if (!values[call.name])
            throw new Error(`Unmodeled fixture read ${call.name}`);
          return abi.encodeFunctionResult(call.fragment, values[call.name]);
        }
        throw new Error(`Unmodeled fixture RPC ${method}`);
      }
    },
  };
});
const account = "0x1111111111111111111111111111111111111111";
const scope: NftScope = {
  slug: "isolated-digital",
  chain: "ethereum",
  contract: "0x2222222222222222222222222222222222222222",
  standard: "erc1155",
  label: "Isolated fixture",
  charity: true,
};
function request(action: "list" | "offer" = "list"): NftRequest {
  return {
    action,
    account,
    collection: scope.slug,
    tokenId: "7",
    quantity: "10",
    priceWei: "10000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}
const session: UserSession = {
  id: "isolated-session",
  address: account,
  chainId: 1,
  expiresAt: Date.now() + 86400000,
  accessExpiresAt: Date.now() + 86400000,
};
beforeEach(() => {
  state.operations.clear();
  state.order = null;
  state.recipient = account;
  state.rpcMethods = [];
  state.calls = [];
  state.code = "0x";
  state.valid1271 = false;
  state.submitStatus = 200;
  state.wrongSubmitHash = false;
  state.submitted = [];
  state.journalStatuses = [];
  state.owner = account;
  state.approved = true;
  state.tokenApproved = false;
  state.standard = "erc1155";
  state.balance = 1000000n;
  vi.stubEnv("ARTFI_NFT_TRADING_ENABLED", "true");
  vi.stubEnv("ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE", "sin");
  vi.stubEnv("ARTFI_NFT_RPC_1", "http://127.0.0.1:1");
  vi.stubEnv("OPENSEA_API_KEY", "isolated-test-key");
  vi.stubEnv("ARTFI_NFT_COLLECTIONS_JSON", JSON.stringify([scope]));
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(input);
    state.calls.push(`${init?.method || "GET"} ${url.pathname}`);
    if (init?.method === "POST" && url.pathname.startsWith("/api/v2/orders/")) {
      expect(state.journalStatuses.at(-1)).toBe("submitted");
      const payload = JSON.parse(String(init.body));
      state.submitted.push(payload);
      if (state.submitStatus === 0)
        throw new Error("Isolated network interruption");
      if (state.submitStatus !== 200)
        return Response.json(
          { detail: "isolated refusal" },
          { status: state.submitStatus },
        );
      const hash = state.wrongSubmitHash
        ? `0x${"9".repeat(64)}`
        : orderHash(components(payload.parameters));
      return Response.json({
        order_hash: hash,
        protocol_data: {
          parameters: payload.parameters,
          signature: payload.signature,
        },
      });
    }
    if (url.pathname.startsWith("/api/v2/orders/"))
      return Response.json({ order: state.order });
    if (url.pathname.endsWith("/fulfillment_data")) {
      const p = (
        state.order!.protocolData as { parameters: Record<string, unknown> }
      ).parameters;
      return Response.json({
        fulfillment_data: {
          transaction: {
            to: SEAPORT,
            value: url.pathname.includes("/listings/") ? "10000" : "0",
            function: "fulfillAdvancedOrder",
            input_data: {
              advancedOrder: {
                parameters: {
                  ...p,
                  totalOriginalConsiderationItems: (
                    p.consideration as unknown[]
                  ).length,
                },
                numerator: "1",
                denominator: "1",
                signature: "0x12",
                extraData: "0x",
              },
              criteriaResolvers: [],
              fulfillerConduitKey: getDefaultConduit(Chain.Mainnet).key,
              recipient: state.recipient,
            },
          },
        },
      });
    }
    if (url.pathname === "/api/v2/chains")
      return Response.json({ chains: [{ chain: "ethereum" }] });
    if (url.pathname.includes("/nfts/"))
      return Response.json({
        nft: {
          identifier: "7",
          collection: scope.slug,
          contract: scope.contract,
          token_standard: state.standard,
          name: "Isolated test NFT",
        },
      });
    if (url.pathname === `/api/v2/collections/${scope.slug}`)
      return Response.json({
        collection: scope.slug,
        name: "Isolated",
        fees: [
          {
            fee: 2.5,
            recipient: "0x3333333333333333333333333333333333333333",
            required: true,
          },
        ],
        contracts: [{ address: scope.contract, chain: "ethereum" }],
      });
    throw new Error(`Unmodeled venue request ${url.pathname}`);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("real official SDK with isolated read-only transports", () => {
  it("prepares a genuine SDK listing typed-data request without signing or order submission", async () => {
    const operation = await prepareNftOperation(
      "isolated-listing-0001",
      request(),
      scope,
      session,
      "test-access",
    );
    expect(operation.plan.kind).toBe("signature");
    expect(operation.plan.typedData?.domain).toMatchObject({
      name: "Seaport",
      version: "1.6",
      chainId: 1,
    });
    expect(operation.plan.orderHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(state.calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(state.rpcMethods).not.toContain("eth_sendRawTransaction");
    expect(state.rpcMethods).not.toContain("eth_sendTransaction");
  });
  it("prepares a genuine SDK offer with a bounded WETH amount", async () => {
    const operation = await prepareNftOperation(
      "isolated-offer-00001",
      request("offer"),
      scope,
      session,
      "test-access",
    );
    expect(operation.plan.kind).toBe("signature");
    expect(operation.plan.typedData?.message.offer).toEqual([
      expect.objectContaining({ startAmount: "10000" }),
    ]);
  });
  it("returns the first genuine approval request and never proceeds to signature", async () => {
    state.approved = false;
    const operation = await prepareNftOperation(
      "isolated-approval-001",
      request(),
      scope,
      session,
      "test-access",
    );
    expect(operation.plan.kind).toBe("approval");
    expect(operation.plan.typedData).toBeUndefined();
    expect(
      new Interface([
        "function setApprovalForAll(address,bool)",
      ]).parseTransaction({ data: operation.plan.transaction!.data })?.args[1],
    ).toBe(true);
  });
  it("progresses ERC-721 listing after token-only approval without asking for collection approval", async () => {
    state.approved = false;
    state.standard = "erc721";
    const single = { ...scope, standard: "erc721" as const };
    const input = { ...request(), quantity: "1" };
    const first = await prepareNftOperation(
      "isolated-token-approval",
      input,
      single,
      session,
      "test-access",
    );
    expect(first.plan.kind).toBe("approval");
    expect(
      new Interface(["function approve(address,uint256)"]).parseTransaction({
        data: first.plan.transaction!.data,
      })?.args[1],
    ).toBe(7n);
    state.tokenApproved = true;
    const second = await prepareNftOperation(
      "isolated-token-signature",
      input,
      single,
      session,
      "test-access",
    );
    expect(second.plan.kind).toBe("signature");
  });
  it("reuses exact durable operation terms and rejects idempotency rebinding", async () => {
    const input = request();
    const operation = await prepareNftOperation(
      "isolated-repeat-0001",
      input,
      scope,
      session,
      "test-access",
    );
    const calls = state.calls.length;
    expect(
      await prepareNftOperation(
        operation.id,
        input,
        scope,
        session,
        "test-access",
      ),
    ).toEqual(operation);
    expect(state.calls).toHaveLength(calls);
    await expect(
      prepareNftOperation(
        operation.id,
        { ...input, quantity: "11" },
        scope,
        session,
        "test-access",
      ),
    ).rejects.toThrow("different terms");
  });
  it("fails closed before wallet review when the NFT balance is insufficient", async () => {
    state.balance = 1n;
    await expect(
      prepareNftOperation(
        "isolated-short-00001",
        request(),
        scope,
        session,
        "test-access",
      ),
    ).rejects.toThrow("insufficient NFT");
    expect(state.operations.size).toBe(0);
  });
  async function seedOrder(side: "list" | "offer") {
    const made = await prepareNftOperation(
      `isolated-seed-${side}-001`,
      request(side),
      scope,
      session,
      "test-access",
    );
    const p = components(made.plan.typedData!.message);
    const maker = "0x4444444444444444444444444444444444444444";
    p.offerer = maker;
    p.consideration[0].recipient = maker;
    const hash = orderHash(p);
    state.order = {
      protocolAddress: SEAPORT,
      orderHash: hash,
      protocolData: { parameters: p, signature: "0x12" },
      type: side === "list" ? "basic" : "criteria",
    };
    return hash;
  }
  it.each(["buy", "accept"] as const)(
    "prepares official SDK %s calldata bound to the canonical order",
    async (action) => {
      const hash = await seedOrder(action === "buy" ? "list" : "offer");
      const input = { ...request(), action, orderHash: hash };
      const result = await prepareNftOperation(
        `isolated-${action}-terminal`,
        input,
        scope,
        session,
        "test-access",
      );
      expect(result.plan.kind).toBe("transaction");
      expect(result.plan.orderHash).toBe(hash);
      expect(result.plan.orderExpiresAt).toBe(
        Number(
          (state.order!.protocolData as { parameters: { endTime: string } })
            .parameters.endTime,
        ),
      );
      expect(result.plan.paymentToken).toBe(action === "buy" ? "ETH" : "WETH");
      expect(
        new Interface(SeaportABI).parseTransaction({
          data: result.plan.transaction!.data,
        })?.name,
      ).toBe("fulfillAdvancedOrder");
    },
  );
  it("prepares missing NFT approval before offer acceptance", async () => {
    const hash = await seedOrder("offer");
    state.approved = false;
    const result = await prepareNftOperation(
      "isolated-accept-approval",
      { ...request(), action: "accept", orderHash: hash },
      scope,
      session,
      "test-access",
    );
    expect(result.plan.kind).toBe("approval");
    expect(result.plan.transaction?.to).toBe(scope.contract);
  });
  it("prepares an on-chain cancellation and rejects a changed fulfillment recipient", async () => {
    const hash = await seedOrder("list");
    const maker = "0x4444444444444444444444444444444444444444";
    const cancelled = await prepareNftOperation(
      "isolated-cancel-0001",
      { ...request(), action: "cancel", orderHash: hash, account: maker },
      scope,
      { ...session, address: maker },
      "test-access",
    );
    expect(
      new Interface(SeaportABI).parseTransaction({
        data: cancelled.plan.transaction!.data,
      })?.name,
    ).toBe("cancel");
    state.recipient = maker;
    await expect(
      prepareNftOperation(
        "isolated-badrecipient",
        { ...request(), action: "buy", orderHash: hash },
        scope,
        session,
        "test-access",
      ),
    ).rejects.toThrow("recipient");
  });
  it("fails closed on session chain mismatch before reading the venue", async () => {
    await expect(
      prepareNftOperation(
        "isolated-chain-00001",
        request(),
        scope,
        { ...session, chainId: 8453 },
        "test-access",
      ),
    ).rejects.toThrow("Sign in");
    expect(state.calls).toHaveLength(0);
  });
});

describe("real signature verification and official order submission transport", () => {
  async function signed(action: "list" | "offer" = "list") {
    // Ephemeral test-only key stays in memory, has no funds and never reaches a real RPC or venue.
    const signer = Wallet.createRandom();
    const account = signer.address as `0x${string}`;
    const auth = { ...session, address: account };
    const operation = await prepareNftOperation(
      "isolated-signed-operation",
      { ...request(action), account },
      scope,
      auth,
      "isolated-access",
    );
    operation.walletStarted = true;
    const typed = operation.plan.typedData!;
    const signature = await signer.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    );
    return { operation, signature, auth };
  }
  it.each(["list", "offer"] as const)(
    "verifies a genuine EOA %s signature, journals before relay and does not store the signature",
    async (action) => {
      const { operation, signature, auth } = await signed(action);
      const result = await submitNftSignature(
        operation,
        signature,
        auth,
        "isolated-access",
      );
      expect(result.status).toBe("accepted");
      expect(state.submitted).toHaveLength(1);
      expect(state.calls.at(-1)).toContain(
        action === "list" ? "/listings" : "/offers",
      );
      expect(JSON.stringify([...state.operations.values()])).not.toContain(
        signature,
      );
      await submitNftSignature(result, signature, auth, "isolated-access");
      expect(state.submitted).toHaveLength(1);
    },
  );
  it("rejects another wallet's valid signature without submission", async () => {
    const { operation, auth } = await signed();
    const other = Wallet.createRandom(),
      typed = operation.plan.typedData!;
    const signature = await other.signTypedData(
      typed.domain,
      typed.types,
      typed.message,
    );
    await expect(
      submitNftSignature(operation, signature, auth, "isolated-access"),
    ).rejects.toThrow("does not match");
    expect(state.submitted).toHaveLength(0);
  });
  it.each([false, true])(
    "requires the EIP-1271 magic value (valid=%s)",
    async (valid) => {
      const { operation, auth } = await signed();
      state.code = "0x6001";
      state.valid1271 = valid;
      const result = submitNftSignature(
        operation,
        "0x1234",
        auth,
        "isolated-access",
      );
      if (valid) expect((await result).status).toBe("accepted");
      else await expect(result).rejects.toThrow("does not match");
      expect(state.submitted).toHaveLength(valid ? 1 : 0);
    },
  );
  it.each([400, 401, 403, 404, 422, 429, 500, 0])(
    "records truthful submit outcome for upstream status %s",
    async (status) => {
      const { operation, signature, auth } = await signed();
      state.submitStatus = status;
      const result = await submitNftSignature(
        operation,
        signature,
        auth,
        "isolated-access",
      );
      expect(result.status).toBe(
        [400, 401, 403, 404, 422].includes(status) ? "rejected" : "pending",
      );
      expect(state.submitted).toHaveLength(1);
      expect(JSON.stringify([...state.operations.values()])).not.toContain(
        signature,
      );
    },
  );
  it("keeps an incompatible success response pending", async () => {
    const { operation, signature, auth } = await signed();
    state.wrongSubmitHash = true;
    expect(
      (await submitNftSignature(operation, signature, auth, "isolated-access"))
        .status,
    ).toBe("pending");
  });
  it("requires the durable wallet-start record before submission", async () => {
    const { operation, signature, auth } = await signed();
    operation.walletStarted = false;
    await expect(
      submitNftSignature(operation, signature, auth, "isolated-access"),
    ).rejects.toThrow("durably started");
    expect(state.submitted).toHaveLength(0);
  });
});
