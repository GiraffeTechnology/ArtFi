import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Interface, Network } from "ethers";
import {
  OpenSeaAPI,
  OpenSeaSDK,
  Chain,
  getDefaultConduit,
  type FetchImpl,
} from "@opensea/sdk";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import {
  createNativeNftTaskPort,
  type NativeNftTaskPortDependencies,
  type VerifiedNftTask,
} from "./task-port";
import { ReadOnlyNftProvider } from "./recorder";
import { components, orderHash, sdkChain } from "./validation";
import { kernelRequestDigest } from "../../../../../scripts/agent/agent-kernel.mjs";
import {
  NftError,
  type NftRequest,
  type NftScope,
  type NftTaskBinding,
} from "./model";
import type { NftOperation } from "./journal";

const seller = "0x1111111111111111111111111111111111111111";
const nft = "0x2222222222222222222222222222222222222222";
const fee = "0x3333333333333333333333333333333333333333";
const taskBinding: NftTaskBinding = {
  taskId: "synthetic-task",
  operationId: "synthetic-wallet-child",
  taskDigest: `0x${"1".repeat(64)}`,
  executorDigest: `0x${"2".repeat(64)}`,
  grantReference: "grant:synthetic",
  grantPolicyVersion: "1",
};
const scope: NftScope = {
  slug: "synthetic-digital",
  chain: "ethereum",
  contract: nft,
  standard: "erc1155",
  label: "Synthetic only",
  charity: false,
};
const abi = new Interface([
  ...SeaportABI,
  "function balanceOf(address,uint256) view returns(uint256)",
  "function ownerOf(uint256) view returns(address)",
  "function isApprovedForAll(address,address) view returns(bool)",
  "function getApproved(uint256) view returns(address)",
  "function isValidSignature(bytes32,bytes) view returns(bytes4)",
]);
function fixture() {
  const store = new Map<string, NftOperation>();
  const state = {
    scope: structuredClone(scope),
    approved: true,
    tokenApproved: false,
    balance: 1000000n,
    counter: 0n,
    owner: seller,
    code: "0x01",
    validSignature: true,
    revoked: false,
    blockedTerms: false,
    offline: false,
    wrongHash: false,
    visible: false,
    posts: 0,
    writes: [] as NftOperation[],
    purposes: [] as string[],
    rpc: [] as string[],
    authorizeAfterRead: undefined as undefined | (() => void),
    beforeSubmitted: undefined as undefined | (() => Promise<void>),
    gateTask: undefined as VerifiedNftTask | undefined,
    loseReviewResponse: false,
  };
  const request: NftRequest = {
    action: "list",
    account: seller,
    collection: scope.slug,
    tokenId: "7",
    quantity: "10",
    priceWei: "10000",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const verified: VerifiedNftTask = {
    binding: structuredClone(taskBinding),
    actor: seller,
    chainId: 1,
    expiresAt: request.expiresAt + 3600,
    sideEffectDeadlineAtMs: Date.now() + 60000,
    intent: {
      kind: "nft-sale",
      direction: "sell",
      standard: "ERC-1155",
      contract: nft,
      tokenId: "7",
      quantity: "10",
    },
  };
  class SyntheticProvider extends ReadOnlyNftProvider {
    constructor() {
      super("http://127.0.0.1:1", undefined, { cacheTimeout: -1 });
    }
    override async getNetwork() {
      return Network.from(1);
    }
    override async send(
      method: string,
      args: Array<unknown> | Record<string, unknown>,
    ): Promise<unknown> {
      state.rpc.push(method);
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getCode") return state.code;
      if (method === "eth_call") {
        const tx = (args as unknown[])[0] as { data: string };
        const call = abi.parseTransaction(tx);
        if (!call) throw Error("Unmodeled synthetic read");
        const result: Record<string, unknown[]> = {
          balanceOf: [state.balance],
          ownerOf: [state.owner],
          getCounter: [state.counter],
          getOrderStatus: [false, false, 0n, 0n],
          isApprovedForAll: [state.approved],
          getApproved: [
            state.tokenApproved
              ? getDefaultConduit(Chain.Mainnet).address
              : `0x${"0".repeat(40)}`,
          ],
          isValidSignature: [
            state.validSignature &&
            call.name === "isValidSignature" &&
            call.args[1] === "0x1234"
              ? "0x1626ba7e"
              : "0xffffffff",
          ],
        };
        if (!result[call.name])
          throw Error(`Unmodeled synthetic read ${call.name}`);
        const output = abi.encodeFunctionResult(
          call.fragment,
          result[call.name],
        );
        state.authorizeAfterRead?.();
        return output;
      }
      throw Error(`NETWORK FORBIDDEN: ${method}`);
    }
  }
  const fetch: FetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      expect(state.writes.at(-1)?.status).toBe("submitted");
      state.posts++;
      if (state.offline) throw Error("Synthetic lost response");
      const payload = JSON.parse(String(init.body));
      return Response.json({
        order_hash: state.wrongHash
          ? `0x${"9".repeat(64)}`
          : orderHash(components(payload.parameters)),
        protocol_data: { parameters: payload.parameters },
      });
    }
    if (url.pathname.startsWith("/api/v2/orders/")) {
      if (!state.visible) throw Error("Synthetic order not observed");
      const plan = [...store.values()][0].plan;
      return Response.json({
        order: {
          order_hash: plan.orderHash,
          protocol_data: { parameters: plan.typedData!.message },
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
          contract: nft,
          token_standard: state.scope.standard,
          name: "Synthetic only",
        },
      });
    if (url.pathname === `/api/v2/collections/${scope.slug}`)
      return Response.json({
        collection: scope.slug,
        name: "Synthetic only",
        fees: [{ fee: 2.5, recipient: fee, required: true }],
        contracts: [{ address: nft, chain: "ethereum" }],
      });
    throw Error(`Unmodeled synthetic SDK path ${url.pathname}`);
  };
  let grantLock: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = grantLock.then(run);
    grantLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  const revoke = () =>
    exclusive(async () => {
      state.revoked = true;
    });
  const deps: NativeNftTaskPortDependencies = {
    requireTrading: () => {},
    scope: () => state.scope,
    provider: () => new SyntheticProvider(),
    sdk: (recorder, selected) =>
      new OpenSeaSDK(
        recorder as unknown as ConstructorParameters<typeof OpenSeaSDK>[0],
        { chain: sdkChain(selected), fetch, apiKey: "synthetic-no-credential" },
        () => {},
      ),
    api: (selected) =>
      new OpenSeaAPI({
        chain: sdkChain(selected),
        fetch,
        apiKey: "synthetic-no-credential",
      }),
    verifyTaskBinding: async (claimed, context) => {
      state.purposes.push(context.purpose);
      if (
        kernelRequestDigest(claimed) !== kernelRequestDigest(verified.binding)
      )
        throw new NftError(403, "Synthetic wrong task binding");
      if (state.revoked && context.purpose !== "observe")
        throw new NftError(403, "Synthetic grant revoked");
      if (state.blockedTerms && context.plan)
        throw new NftError(
          403,
          "Synthetic grant valuation/price-at/fee terms rejected",
        );
      return verified;
    },
    withTaskAuthorization: async (_binding, purpose, plan, action) => {
      const fresh = await deps.verifyTaskBinding(_binding, { purpose, plan });
      // Synthetic lock model: a real composition MUST share this exclusion with revoke.
      return action(state.gateTask ?? fresh);
    },
    // A synthetic durable CAS model, NOT a production authenticated transport.
    journal: async (principal, action, record) => {
      const current = store.get(record.id);
      if (
        principal.kind !== "task" ||
        principal.taskDigest !== taskBinding.taskDigest
      )
        throw new NftError(403, "Synthetic journal scope mismatch");
      if (action === "get") {
        if (!current) throw new NftError(404, "Synthetic missing");
        return structuredClone(current);
      }
      if (record.status === "submitted") await state.beforeSubmitted?.();
      const next = structuredClone(record) as NftOperation;
      if (JSON.stringify(next).includes("signature" + '\"' + ":"))
        throw Error("SIGNATURE LEAK");
      if (action === "create" && current) {
        if (next.requestHash !== current.requestHash)
          throw new NftError(409, "Synthetic conflicting create");
        return structuredClone(current);
      }
      if (
        action === "update" &&
        (!current ||
          current.revision !== next.revision ||
          kernelRequestDigest(current.plan) !== kernelRequestDigest(next.plan))
      )
        throw new NftError(409, "Synthetic CAS conflict");
      next.revision = current ? current.revision + 1 : 1;
      store.set(next.id, next);
      state.writes.push(structuredClone(next));
      if (
        state.loseReviewResponse &&
        next.walletStarted &&
        next.status === "awaiting-wallet"
      ) {
        state.loseReviewResponse = false;
        throw new NftError(
          503,
          "Synthetic lost review response after durable claim",
        );
      }
      return structuredClone(next);
    },
  };
  const fixedVerifier = deps.verifyTaskBinding;
  deps.withTaskAuthorization = (claimed, purpose, plan, action) =>
    exclusive(async () => {
      const fresh = await fixedVerifier(claimed, { purpose, plan });
      return action(state.gateTask ?? fresh);
    });
  return {
    revoke,
    state,
    store,
    verified,
    request,
    deps,
    port: createNativeNftTaskPort(deps),
  };
}
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw Error("REAL NETWORK FORBIDDEN");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("internal NativeNftTaskPort using the official SDK and fully synthetic transport", () => {
  it("requires fixed composition, never a caller authentication boolean", async () => {
    expect(() =>
      createNativeNftTaskPort({} as NativeNftTaskPortDependencies),
    ).toThrow("not configured");
    const f = fixture();
    await expect(
      f.port.prepareListing(
        { ...taskBinding, authenticated: true } as NftTaskBinding,
        f.request,
      ),
    ).rejects.toThrow("Invalid NFT task binding");
    expect(f.state.rpc).toEqual([]);
  });
  it("prepares exact intent quantity despite larger holdings, keeps independent principal and stable idempotency", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    const repeated = await f.port.prepareListing(taskBinding, f.request);
    expect(repeated).toEqual(ref);
    expect(f.store.size).toBe(1);
    const op = [...f.store.values()][0];
    expect(op.plan.request.quantity).toBe("10");
    expect(op.plan.typedData?.message.offer).toMatchObject([
      { startAmount: "10", endAmount: "10" },
    ]);
    expect(op.plan.sessionId).toBeUndefined();
    expect(op.plan.taskPrincipal).toEqual({ ...taskBinding, kind: "task" });
    expect(ref.reviewDigest).toBe(kernelRequestDigest(op.plan));
    expect(ref.orderHash).not.toBe(ref.typedDataDigest);
    await expect(
      f.port.prepareListing(taskBinding, { ...f.request, priceWei: "20000" }),
    ).rejects.toThrow("different terms");
  });
  it("claims one review durably, publishes exact signature once, and never reports settlement", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await expect(f.port.publishListing(ref, "0x1234")).rejects.toThrow(
      "not durably started",
    );
    const review = await f.port.reviewListing(ref);
    expect(review.reference).toEqual(ref);
    await expect(f.port.reviewListing(ref)).rejects.toThrow("already started");
    expect(await f.port.publishListing(ref, "0x1234")).toMatchObject({
      status: "accepted",
      publicationAccepted: true,
      saleComplete: false,
      settlement: "NOT_ASSESSED",
    });
    await f.port.publishListing(ref, "0x1234");
    await f.port.readPublication(ref);
    expect(f.state.posts).toBe(1);
    expect(f.state.writes.map((v) => v.status)).toEqual([
      "awaiting-wallet",
      "awaiting-wallet",
      "submitted",
      "accepted",
    ]);
    expect(JSON.stringify(f.state.writes)).not.toContain("0x1234");
  });
  it("refuses every non-list action and caller full-wallet quantity", async () => {
    for (const action of ["offer", "buy", "accept", "cancel"] as const) {
      const f = fixture();
      await expect(
        f.port.prepareListing(taskBinding, {
          ...f.request,
          action,
          orderHash: `0x${"f".repeat(64)}`,
        }),
      ).rejects.toThrow();
      expect(f.state.rpc).toEqual([]);
    }
    const f = fixture();
    await expect(
      f.port.prepareListing(taskBinding, { ...f.request, quantity: "1000000" }),
    ).rejects.toThrow("exact seller, asset, quantity");
    expect(f.state.rpc).toEqual([]);
  });
  it("refuses missing approvals without journaling an approval or requesting a transaction", async () => {
    const f = fixture();
    f.state.approved = false;
    await expect(f.port.prepareListing(taskBinding, f.request)).rejects.toThrow(
      "Existing NFT approval is required",
    );
    expect(f.store.size).toBe(0);
    expect(f.state.posts).toBe(0);
    expect(
      f.state.rpc.every((method) =>
        ["eth_call", "eth_chainId"].includes(method),
      ),
    ).toBe(true);
  });
  it("retains exact ERC721 approval support through the existing SDK recorder", async () => {
    const f = fixture();
    f.state.scope.standard = "erc721";
    f.verified.intent.standard = "ERC-721";
    f.verified.intent.quantity = f.request.quantity = "1";
    f.state.approved = false;
    f.state.tokenApproved = true;
    const ref = await f.port.prepareListing(taskBinding, f.request);
    expect((await f.port.reviewListing(ref)).plan.kind).toBe("signature");
  });
  it("rejects changed owner, approval and order counter before publication", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => {
        f.state.balance = 0n;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.approved = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.counter = 1n;
      },
    ]) {
      const f = fixture();
      const ref = await f.port.prepareListing(taskBinding, f.request);
      await f.port.reviewListing(ref);
      change(f);
      await expect(f.port.publishListing(ref, "0x1234")).rejects.toThrow();
      expect(f.state.posts).toBe(0);
    }
  });
  it("requires the existing exact signature verifier and excludes signature bytes from the journal", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    for (const sig of ["bad", "0x", "0xabcd"])
      await expect(f.port.publishListing(ref, sig)).rejects.toThrow();
    expect(f.state.posts).toBe(0);
    expect(JSON.stringify(f.state.writes)).not.toContain("0xabcd");
  });
  it("binds every reference digest and principal to the durable plan", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    for (const key of [
      "nativePlanId",
      "reviewDigest",
      "orderHash",
      "typedDataDigest",
    ] as const)
      await expect(
        f.port.reviewListing({ ...ref, [key]: "wrong" }),
      ).rejects.toThrow("does not match");
    await expect(
      f.port.reviewListing({
        ...ref,
        taskBinding: { ...ref.taskBinding, taskDigest: `0x${"7".repeat(64)}` },
      }),
    ).rejects.toThrow("wrong task binding");
    expect(f.state.posts).toBe(0);
  });
  it("uses the current task verifier for prepared terms, grant revocation and late revocation", async () => {
    const f = fixture();
    f.state.blockedTerms = true;
    await expect(f.port.prepareListing(taskBinding, f.request)).rejects.toThrow(
      "valuation/price-at/fee",
    );
    expect(f.store.size).toBe(0);
    f.state.blockedTerms = false;
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    f.state.authorizeAfterRead = () => {
      f.state.revoked = true;
    };
    await expect(f.port.publishListing(ref, "0x1234")).rejects.toThrow(
      "grant revoked",
    );
    expect(f.state.posts).toBe(0);
  });
  it("retains unknown publication after a lost response and restart, never blindly reposts", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    f.state.offline = true;
    expect((await f.port.publishListing(ref, "0x1234")).status).toBe("pending");
    const restarted = createNativeNftTaskPort(f.deps);
    await restarted.publishListing(ref, "0x1234");
    expect(f.state.posts).toBe(1);
    f.state.revoked = true;
    f.state.visible = true;
    expect(await restarted.readPublication(ref)).toMatchObject({
      status: "accepted",
      publicationAccepted: true,
      saleComplete: false,
    });
    await expect(restarted.publishListing(ref, "0x1234")).rejects.toThrow(
      "revoked",
    );
    expect(f.state.posts).toBe(1);
  });
  it("mismatched venue acceptance remains unknown until same-order reconciliation", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    f.state.wrongHash = true;
    expect((await f.port.publishListing(ref, "0x1234")).status).toBe("pending");
    expect((await f.port.readPublication(ref)).status).toBe("pending");
    f.state.visible = true;
    expect((await f.port.readPublication(ref)).status).toBe("accepted");
    expect(f.state.posts).toBe(1);
  });
  it("CAS permits only one concurrent review and one concurrent publication", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    const reviews = await Promise.allSettled([
      f.port.reviewListing(ref),
      f.port.reviewListing(ref),
    ]);
    expect(reviews.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const posts = await Promise.allSettled([
      f.port.publishListing(ref, "0x1234"),
      f.port.publishListing(ref, "0x1234"),
    ]);
    expect(posts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.state.posts).toBe(1);
  });
  it("pins verifier and journal functions and rejects session principal substitution", async () => {
    const f = fixture();
    f.deps.withTaskAuthorization = async () => {
      throw Error("Replaced gate");
    };
    f.deps.verifyTaskBinding = async () => {
      throw Error("Replaced verifier");
    };
    const ref = await f.port.prepareListing(taskBinding, f.request);
    const op = f.store.get(ref.nativeOperationId)!;
    op.plan.sessionId = "forged-login";
    await expect(f.port.reviewListing(ref)).rejects.toThrow();
    expect(f.state.posts).toBe(0);
  });
  it("holds the same grant lock across submitted CAS and publication dispatch", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    let revocation: Promise<void> | undefined;
    f.state.beforeSubmitted = async () => {
      revocation = f.revoke();
      await Promise.resolve();
      expect(f.state.revoked).toBe(false);
    };
    const result = await f.port.publishListing(ref, "0x1234");
    await revocation;
    expect(result.status).toBe("accepted");
    expect(f.state.revoked).toBe(true);
    expect((await f.port.readPublication(ref)).publicationAccepted).toBe(true);
    expect(f.state.posts).toBe(1);
  });
  it("blocks revocation ordered before the final publication capability", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    await f.revoke();
    await expect(f.port.publishListing(ref, "0x1234")).rejects.toThrow(
      "revoked",
    );
    expect(f.state.posts).toBe(0);
    expect((await f.port.readPublication(ref)).status).toBe("awaiting-wallet");
  });
  it("allows observation after grant and review expiry without another signature or publication", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    f.state.offline = true;
    await f.port.publishListing(ref, "0x1234");
    vi.spyOn(Date, "now").mockReturnValue((f.verified.expiresAt + 1) * 1000);
    await expect(f.port.publishListing(ref, "0x1234")).rejects.toThrow();
    expect((await f.port.readPublication(ref)).status).toBe("pending");
    f.state.visible = true;
    expect((await f.port.readPublication(ref)).status).toBe("accepted");
    expect(f.state.posts).toBe(1);
  });
  it("rechecks configuration and task expiry for review and does not reuse a changed scope", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    f.state.scope.label = "Changed collection configuration";
    await expect(f.port.reviewListing(ref)).rejects.toThrow(
      "configuration changed",
    );
    expect(f.state.posts).toBe(0);
  });
  it.each(["review", "task", "order"] as const)(
    "does not dispatch when the submitted journal await crosses %s expiry",
    async (boundary) => {
      const f = fixture();
      const ref = await f.port.prepareListing(taskBinding, f.request);
      await f.port.reviewListing(ref);
      const plan = f.store.get(ref.nativeOperationId)!.plan;
      const expiresAt =
        boundary === "review"
          ? plan.expiresAt
          : boundary === "task"
            ? f.verified.expiresAt * 1000
            : f.request.expiresAt * 1000;
      f.state.beforeSubmitted = async () => {
        await Promise.resolve();
        vi.spyOn(Date, "now").mockReturnValue(expiresAt + 1);
      };
      const result = await f.port.publishListing(ref, "0x1234");
      expect(result.status).toBe("pending");
      expect(f.state.posts).toBe(0);
      expect(f.state.writes.map((x) => x.status)).toEqual([
        "awaiting-wallet",
        "awaiting-wallet",
        "submitted",
        "pending",
      ]);
      expect((await f.port.readPublication(ref)).status).toBe("pending");
    },
  );
  it("uses the durable gate's fresh task intent rather than the earlier verifier snapshot", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    f.state.gateTask = structuredClone(f.verified);
    f.state.gateTask.intent.quantity = "11";
    await expect(f.port.publishListing(ref, "0x1234")).rejects.toThrow(
      "exact seller, asset, quantity",
    );
    expect(f.state.posts).toBe(0);
    expect(f.state.writes.at(-1)?.status).toBe("awaiting-wallet");
  });
  it("recovers the same unsigned review after a lost response without resetting signing uncertainty", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    const original = structuredClone(f.store.get(ref.nativeOperationId)!.plan);
    expect(
      (await f.port.readPublication(ref)).recoverySnapshot.signingState,
    ).toBe("NOT_STARTED");
    f.state.loseReviewResponse = true;
    await expect(f.port.reviewListing(ref)).rejects.toThrow(
      "lost review response",
    );
    const restarted = createNativeNftTaskPort(f.deps);
    await expect(restarted.reviewListing(ref)).rejects.toThrow(
      "already started",
    );
    await f.revoke();
    vi.spyOn(Date, "now").mockReturnValue((f.verified.expiresAt + 1) * 1000);
    const recovery = (await restarted.readPublication(ref)).recoverySnapshot;
    expect(recovery).toEqual({
      unsignedPlan: original,
      walletStarted: true,
      signingState: "STARTED_OUTCOME_UNKNOWN",
      authority: "READ_ONLY_NOT_SIGNING_AUTHORIZATION",
    });
    expect(kernelRequestDigest(recovery.unsignedPlan)).toBe(ref.reviewDigest);
    recovery.unsignedPlan.request.quantity = "999";
    expect(
      (await restarted.readPublication(ref)).recoverySnapshot.unsignedPlan,
    ).toEqual(original);
    expect(f.state.writes.filter((x) => x.walletStarted)).toHaveLength(1);
    expect(f.state.posts).toBe(0);
  });
  it("does not dispatch when the submitted journal await crosses the fresh quote/policy deadline", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    await f.port.reviewListing(ref);
    f.state.gateTask = structuredClone(f.verified);
    f.state.gateTask.sideEffectDeadlineAtMs = Date.now() + 1000;
    f.state.beforeSubmitted = async () => {
      await Promise.resolve();
      vi.spyOn(Date, "now").mockReturnValue(
        f.state.gateTask!.sideEffectDeadlineAtMs!,
      );
    };
    expect((await f.port.publishListing(ref, "0x1234")).status).toBe("pending");
    expect(f.state.posts).toBe(0);
    expect(f.store.get(ref.nativeOperationId)!.plan.request.expiresAt).toBe(
      f.request.expiresAt,
    );
  });
  it("requires an explicit trusted side-effect deadline without shortening order expiry", async () => {
    const f = fixture();
    const ref = await f.port.prepareListing(taskBinding, f.request);
    delete f.verified.sideEffectDeadlineAtMs;
    await expect(f.port.reviewListing(ref)).rejects.toThrow(
      "deadline is missing or expired",
    );
    expect(
      (await f.port.readPublication(ref)).recoverySnapshot.walletStarted,
    ).toBe(false);
    f.verified.sideEffectDeadlineAtMs = Date.now() + 30000;
    expect((await f.port.reviewListing(ref)).plan.request.expiresAt).toBe(
      f.request.expiresAt,
    );
    expect(f.request.expiresAt * 1000).toBeGreaterThan(
      f.verified.sideEffectDeadlineAtMs,
    );
    expect(f.state.posts).toBe(0);
  });
});
