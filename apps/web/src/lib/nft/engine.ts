import "server-only";
import { randomUUID } from "node:crypto";
import {
  Contract,
  FetchRequest,
  Interface,
  verifyTypedData,
  TypedDataEncoder,
  formatEther,
} from "ethers";
import {
  OpenSeaSDK,
  OrderSide,
  getDefaultConduit,
  type OpenSeaAPI,
} from "@opensea/sdk";
import { SeaportABI } from "@opensea/seaport-js/lib/abi/Seaport";
import type { UserSession } from "../user-auth";
import {
  nftScope,
  nftAPIKey,
  nftRPC,
  SEAPORT,
  WETH,
  requireNftTrading,
} from "./config";
import {
  NFT_CHAINS,
  NftError,
  equalAddress,
  fail,
  object,
  type NftRequest,
  type NftScope,
  type NftPlan,
  type NftOrderView,
  type NftTransaction,
} from "./model";
import {
  components,
  orderHash,
  sdkChain,
  validateComponents,
  validateTransaction,
  validateTypedData,
  type Components,
} from "./validation";
import { NftPlanRecorder, ReadOnlyNftProvider } from "./recorder";
import {
  nftAPI,
  venueFetch,
  checkNftChain,
  safeNft,
  NftVenueRejection,
} from "./venue";
import { nftJournal, nftRequestHash, type NftOperation } from "./journal";

const seaportABI = new Interface(SeaportABI);
const assetABI = [
  "function ownerOf(uint256) view returns(address)",
  "function balanceOf(address,uint256) view returns(uint256)",
];
function provider(scope: NftScope) {
  const request = new FetchRequest(nftRPC(NFT_CHAINS[scope.chain]));
  request.timeout = 12000;
  return new ReadOnlyNftProvider(request, undefined, {
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
}
function sessionMatches(
  session: UserSession,
  request: NftRequest,
  scope: NftScope,
) {
  if (
    !equalAddress(session.address, request.account) ||
    session.chainId !== NFT_CHAINS[scope.chain]
  )
    fail("Sign in with the selected wallet on the NFT chain.", 403);
}
async function canonicalOrder(
  api: OpenSeaAPI,
  request: NftRequest,
  scope: NftScope,
) {
  const raw = await api.orders.getOrderByHash(
    request.orderHash!,
    SEAPORT,
    sdkChain(scope),
  );
  const record = object(raw);
  if (
    !equalAddress(record.protocolAddress, SEAPORT) ||
    record.orderHash !== request.orderHash
  )
    fail("The venue returned a different order.");
  const p = components(object(record.protocolData).parameters);
  if (orderHash(p).toLowerCase() !== request.orderHash?.toLowerCase())
    fail("The venue order hash does not match its signed terms.");
  const terms = validateComponents(p, request, scope, false);
  if (
    (request.action === "buy" && !terms.listing) ||
    (request.action === "accept" && terms.listing)
  )
    fail("The selected order has the wrong side.");
  return { raw, p, terms };
}
async function chainEligibility(
  rpc: ReadOnlyNftProvider,
  scope: NftScope,
  request: NftRequest,
  p?: Components,
) {
  if (Number((await rpc.getNetwork()).chainId) !== NFT_CHAINS[scope.chain])
    fail("The NFT chain connection is on another network.", 503);
  const market = new Contract(SEAPORT, SeaportABI, rpc);
  if (p) {
    const [status, counter] = await Promise.all([
      market.getOrderStatus(orderHash(p)),
      market.getCounter(p.offerer),
    ]);
    if (
      request.action !== "cancel" &&
      (status.isCancelled ||
        (BigInt(status.totalSize) > 0n &&
          BigInt(status.totalFilled) >= BigInt(status.totalSize)) ||
        String(counter) !== p.counter)
    )
      fail("This order was cancelled, replaced or filled.", 409);
    const terms = validateComponents(p, request, scope, false);
    if (request.action !== "cancel" && BigInt(status.totalSize) > 0n) {
      const size = BigInt(terms.nft.startAmount),
        remaining =
          (size * (BigInt(status.totalSize) - BigInt(status.totalFilled))) /
          BigInt(status.totalSize);
      if (BigInt(request.quantity) > remaining)
        fail("The available quantity changed.", 409);
    }
  }
  if (request.action === "list" || request.action === "accept") {
    const nft = new Contract(scope.contract, assetABI, rpc);
    if (scope.standard === "erc721") {
      if (!equalAddress(await nft.ownerOf(request.tokenId), request.account))
        fail("The connected wallet no longer owns this NFT.", 409);
    } else if (
      BigInt(await nft.balanceOf(request.account, request.tokenId)) <
      BigInt(request.quantity)
    )
      fail("The connected wallet has insufficient NFT quantity.", 409);
  }
  if (
    request.action === "buy" &&
    (await rpc.getBalance(request.account)) < BigInt(request.priceWei)
  )
    fail("The wallet has insufficient ETH for this purchase.", 409);
  if (request.action === "offer") {
    const weth = new Contract(
      WETH[scope.chain],
      ["function balanceOf(address) view returns(uint256)"],
      rpc,
    );
    if (
      BigInt(await weth.balanceOf(request.account)) < BigInt(request.priceWei)
    )
      fail("The wallet needs sufficient WETH before making this offer.", 409);
  }
}
async function acceptanceApproval(
  rpc: ReadOnlyNftProvider,
  scope: NftScope,
  request: NftRequest,
  transaction: NftTransaction,
): Promise<NftTransaction | null> {
  if (request.action !== "accept") return null;
  const decoded = seaportABI.parseTransaction({ data: transaction.data });
  if (!decoded) fail("Unknown fulfillment method.");
  let key: string;
  if (decoded.name === "fulfillAdvancedOrder") key = String(decoded.args[2]);
  else if (decoded.name === "fulfillOrder") key = String(decoded.args[1]);
  else key = String(decoded.args[0].fulfillerConduitKey);
  const spender =
    key === `0x${"0".repeat(64)}`
      ? SEAPORT
      : getDefaultConduit(sdkChain(scope)).address;
  const approvalABI = [
    "function isApprovedForAll(address,address) view returns(bool)",
    "function getApproved(uint256) view returns(address)",
    "function approve(address,uint256)",
    "function setApprovalForAll(address,bool)",
  ];
  const nft = new Contract(scope.contract, approvalABI, rpc);
  if (await nft.isApprovedForAll(request.account, spender)) return null;
  const encoder = new Interface(approvalABI);
  if (scope.standard === "erc721") {
    if (equalAddress(await nft.getApproved(request.tokenId), spender))
      return null;
    return {
      to: scope.contract,
      value: "0",
      data: encoder.encodeFunctionData("approve", [
        spender,
        request.tokenId,
      ]) as `0x${string}`,
    };
  }
  return {
    to: scope.contract,
    value: "0",
    data: encoder.encodeFunctionData("setApprovalForAll", [
      spender,
      true,
    ]) as `0x${string}`,
  };
}

function operationRecord(plan: NftPlan): NftOperation {
  return {
    id: plan.operationId,
    wallet: plan.request.account,
    chainId: plan.chainId,
    requestHash: nftRequestHash(plan.request),
    revision: 1,
    status: "awaiting-wallet",
    plan,
    updatedAt: new Date().toISOString(),
  };
}
export async function prepareNftOperation(
  operationId: string,
  request: NftRequest,
  scope: NftScope,
  session: UserSession,
  accessToken: string,
): Promise<NftOperation> {
  requireNftTrading();
  sessionMatches(session, request, scope);
  try {
    const saved = await nftJournal("get", { id: operationId }, accessToken);
    if (saved.requestHash !== nftRequestHash(request))
      fail("The operation ID belongs to different terms.", 409);
    return saved;
  } catch (error) {
    if (!(error instanceof NftError) || error.status !== 404) throw error;
  }
  const rpc = provider(scope);
  const recorder = new NftPlanRecorder(request.account, rpc);
  const sdk = new OpenSeaSDK(
    recorder as unknown as ConstructorParameters<typeof OpenSeaSDK>[0],
    {
      chain: sdkChain(scope),
      apiKey: nftAPIKey(),
      fetch: venueFetch("prepare"),
    },
    () => undefined,
  );
  // Use Seaport's public exact-approval mode. The pinned SDK does not account for
  // existing ERC-721 token-specific approvals, so remove only that redundant action
  // after independently verifying getApproved for this one selected token.
  const createOrder = sdk.seaport.createOrder.bind(sdk.seaport);
  sdk.seaport.createOrder = async (input, accountAddress) => {
    const useCase = await createOrder(input, accountAddress, true);
    if (scope.standard === "erc721" && request.action === "list") {
      const nft = new Contract(
        scope.contract,
        ["function getApproved(uint256) view returns(address)"],
        rpc,
      );
      const approved = await nft.getApproved(request.tokenId);
      for (let index = useCase.actions.length - 1; index >= 0; index--) {
        const action = useCase.actions[index];
        if (
          action.type === "approval" &&
          action.itemType === 2 &&
          equalAddress(action.token, scope.contract) &&
          String(action.identifierOrCriteria) === request.tokenId &&
          equalAddress(action.operator, approved)
        )
          Array.prototype.splice.call(useCase.actions, index, 1);
      }
    }
    return useCase;
  };
  try {
    await checkNftChain(sdk.api, scope);
    const detail = await sdk.api.nfts.getNFT(
      scope.contract,
      request.tokenId,
      sdkChain(scope),
    );
    if (safeNft(detail.nft, scope).tokenId !== request.tokenId)
      fail("The venue NFT identifier changed.");
    const creating = request.action === "list" || request.action === "offer";
    const canonical = creating
      ? undefined
      : await canonicalOrder(sdk.api, request, scope);
    await chainEligibility(rpc, scope, request, canonical?.p);
    try {
      if (creating) {
        const args = {
          asset: { tokenAddress: scope.contract, tokenId: request.tokenId },
          accountAddress: request.account,
          amount: formatEther(BigInt(request.priceWei)),
          quantity: request.quantity,
          expirationTime: request.expiresAt,
        };
        if (request.action === "list") await sdk.createListing(args);
        else await sdk.createOffer(args);
      } else if (request.action === "cancel")
        await sdk.cancelOrder({
          orderHash: request.orderHash!,
          protocolAddress: SEAPORT,
          accountAddress: request.account,
        });
      else
        await sdk.fulfillOrder({
          order: {
            ...canonical!.raw,
            side:
              request.action === "buy" ? OrderSide.LISTING : OrderSide.OFFER,
          },
          accountAddress: request.account,
          assetContractAddress: scope.contract,
          tokenId: request.tokenId,
          unitsToFill: request.quantity,
          ...(request.action === "buy"
            ? { recipientAddress: request.account }
            : {}),
        });
    } catch (error) {
      if (!recorder.captured) throw error;
    }
    const captured = recorder.captured;
    if (!captured)
      fail("The venue did not return a reviewable wallet action.", 503);
    const plan: NftPlan = {
      id: randomUUID(),
      operationId,
      sessionId: session.id,
      chainId: session.chainId,
      request,
      scope,
      expiresAt: Date.now() + 120000,
      kind: "transaction",
      summary: "",
      fees: [],
      ...(safeNft(detail.nft, scope).sourceURL
        ? { sourceURL: safeNft(detail.nft, scope).sourceURL }
        : {}),
      ...(canonical ? { orderTotalWei: canonical.terms.total.toString() } : {}),
      orderExpiresAt: canonical
        ? Number(canonical.p.endTime)
        : request.expiresAt,
      paymentToken: canonical
        ? canonical.terms.listing
          ? "ETH"
          : "WETH"
        : request.action === "list"
          ? "ETH"
          : "WETH",
    };
    if ("typedData" in captured) {
      const p = validateTypedData(captured.typedData, request, scope);
      const terms = validateComponents(p, request, scope, true);
      plan.kind = "signature";
      plan.typedData = captured.typedData;
      plan.orderHash = orderHash(p);
      plan.fees = terms.fees;
      plan.orderTotalWei = terms.total.toString();
      plan.summary = `Sign a ${request.action} for ${request.quantity} token(s). Total ${formatEther(terms.total)} ${request.action === "list" ? "ETH" : "WETH"}. The order expires ${new Date(request.expiresAt * 1000).toISOString()}.`;
    } else {
      plan.transaction = validateTransaction(
        captured.transaction,
        request,
        scope,
        canonical?.p,
      );
      const approval = await acceptanceApproval(
        rpc,
        scope,
        request,
        plan.transaction,
      );
      if (approval)
        plan.transaction = validateTransaction(
          approval,
          request,
          scope,
          canonical?.p,
        );
      plan.orderHash = request.orderHash;
      plan.kind = equalAddress(plan.transaction.to, SEAPORT)
        ? "transaction"
        : "approval";
      plan.summary =
        plan.kind === "approval"
          ? scope.standard === "erc1155" &&
            equalAddress(plan.transaction.to, scope.contract)
            ? "Approve the OpenSea conduit for this NFT collection. This collection-wide approval also covers other token IDs. You can revoke it in your wallet."
            : request.action === "offer"
              ? `Approve exactly ${formatEther(BigInt(request.priceWei))} WETH for the OpenSea conduit.`
              : "Approve only this NFT token for the OpenSea conduit."
          : `Confirm ${request.action} of ${request.quantity} token(s) through Seaport. Native value: ${formatEther(BigInt(plan.transaction.value))} ETH, plus wallet-estimated gas.`;
      plan.fees = canonical?.terms.fees || [];
    }
    return await nftJournal("create", operationRecord(plan), accessToken);
  } catch (error) {
    if (error instanceof NftError) throw error;
    throw new NftError(
      503,
      "The venue could not prepare this action. Refresh the order and check wallet balances and approvals.",
      { cause: error },
    );
  } finally {
    rpc.destroy();
  }
}
function checkCurrentPlan(operation: NftOperation, session: UserSession) {
  const plan = operation.plan;
  const currentScope = nftScope(plan.request.collection);
  if (
    (Object.keys(currentScope) as (keyof NftScope)[]).some(
      (key) => currentScope[key] !== plan.scope[key],
    )
  )
    fail("The collection configuration changed. Prepare a new review.", 409);
  sessionMatches(session, plan.request, plan.scope);
  if (plan.sessionId !== session.id || plan.expiresAt <= Date.now())
    fail(
      "This wallet review expired or belongs to an earlier sign-in. Prepare a new review.",
      409,
    );
  return plan;
}
export async function submitNftSignature(
  operation: NftOperation,
  signature: string,
  session: UserSession,
  accessToken: string,
) {
  requireNftTrading();
  const plan = checkCurrentPlan(operation, session);
  if (plan.kind !== "signature" || !plan.typedData || !plan.orderHash)
    fail("This operation does not request an order signature.");
  if (operation.status !== "awaiting-wallet")
    return reconcileNftOperation(operation, accessToken);
  if (!operation.walletStarted)
    fail("The wallet request was not durably started.", 409);
  if (!/^0x(?:[a-fA-F0-9]{2}){1,8192}$/.test(signature))
    fail("Invalid wallet signature.", 400);
  const p = validateTypedData(plan.typedData, plan.request, plan.scope);
  const rpc = provider(plan.scope);
  try {
    await chainEligibility(rpc, plan.scope, plan.request);
    let verified = false;
    try {
      verified = equalAddress(
        verifyTypedData(
          plan.typedData.domain,
          plan.typedData.types,
          plan.typedData.message,
          signature,
        ),
        plan.request.account,
      );
    } catch {
      /* EIP-1271 follows. */
    }
    if (!verified && (await rpc.getCode(plan.request.account)) !== "0x") {
      const digest = TypedDataEncoder.hash(
        plan.typedData.domain,
        plan.typedData.types,
        plan.typedData.message,
      );
      const wallet = new Contract(
        plan.request.account,
        ["function isValidSignature(bytes32,bytes) view returns(bytes4)"],
        rpc,
      );
      verified =
        (await wallet.isValidSignature(digest, signature)) === "0x1626ba7e";
    }
    if (!verified)
      fail(
        "The signature does not match the authenticated wallet and reviewed terms.",
        401,
      );
    // Persist uncertainty before any externally visible order submission. Signature never enters the journal.
    operation = await nftJournal(
      "update",
      { ...operation, status: "submitted", orderHash: plan.orderHash },
      accessToken,
    );
    try {
      const api = nftAPI(plan.scope, "submit");
      const signed = {
        parameters: {
          ...p,
          consideration: p.consideration.map((item) => ({
            ...item,
            recipient: item.recipient!,
          })),
          totalOriginalConsiderationItems: p.consideration.length,
        },
        signature,
      };
      const result =
        plan.request.action === "list"
          ? await api.orders.postListing(signed, SEAPORT)
          : await api.orders.postOffer(signed, SEAPORT);
      if (
        result.orderHash?.toLowerCase() !== plan.orderHash.toLowerCase() ||
        orderHash(components(result.protocolData?.parameters)) !==
          plan.orderHash
      )
        throw new NftError(503, "The venue response needs reconciliation.");
      return await nftJournal(
        "update",
        { ...operation, status: "accepted" },
        accessToken,
      );
    } catch (error) {
      return await nftJournal(
        "update",
        {
          ...operation,
          status: error instanceof NftVenueRejection ? "rejected" : "pending",
        },
        accessToken,
      );
    }
  } finally {
    rpc.destroy();
  }
}
function assertTransactionBinding(
  tx: { from: string; to: string | null; data: string; value: bigint },
  plan: NftPlan,
) {
  if (
    !plan.transaction ||
    !equalAddress(tx.from, plan.request.account) ||
    !equalAddress(tx.to, plan.transaction.to) ||
    tx.data.toLowerCase() !== plan.transaction.data.toLowerCase() ||
    tx.value.toString() !== plan.transaction.value
  )
    fail("The transaction does not match the reviewed NFT action.", 409);
}
export async function recordNftTransaction(
  operation: NftOperation,
  hash: string,
  session: UserSession,
  accessToken: string,
) {
  const plan = operation.plan;
  sessionMatches(session, plan.request, plan.scope);
  if (
    plan.kind === "signature" ||
    !plan.transaction ||
    !/^0x[a-fA-F0-9]{64}$/.test(hash)
  )
    fail("Invalid transaction record.", 400);
  if (!operation.walletStarted)
    fail("The wallet request was not durably started.", 409);
  // A delayed broadcast may arrive after plan expiry; preserve the original binding and reconcile it.
  if (
    operation.transactionHash &&
    operation.transactionHash.toLowerCase() !== hash.toLowerCase()
  )
    fail(
      "This operation already tracks another transaction. Inspect it before retrying.",
      409,
    );
  if (
    operation.status === "awaiting-wallet" ||
    (operation.status === "pending" && !operation.transactionHash)
  ) {
    // Verify a pasted hash before making it immutable. A missing RPC observation
    // stays recoverable locally and never poisons the durable operation identity.
    const rpc = provider(plan.scope);
    try {
      if (Number((await rpc.getNetwork()).chainId) !== plan.chainId)
        fail("The receipt service is on another chain.", 503);
      const tx = await rpc.getTransaction(hash);
      if (!tx)
        fail(
          "This transaction is not visible on the configured chain yet. Keep its hash and check again.",
          409,
        );
      assertTransactionBinding(tx, plan);
    } finally {
      rpc.destroy();
    }
    operation = await nftJournal(
      "update",
      { ...operation, status: "pending", transactionHash: hash.toLowerCase() },
      accessToken,
    );
  }
  return reconcileNftOperation(operation, accessToken);
}
export async function reconcileNftOperation(
  operation: NftOperation,
  accessToken: string,
): Promise<NftOperation> {
  const plan = operation.plan;
  if (plan.kind === "signature") {
    if (!["pending", "submitted"].includes(operation.status)) return operation;
    try {
      const record = await nftAPI(plan.scope).orders.getOrderByHash(
        plan.orderHash!,
        SEAPORT,
        sdkChain(plan.scope),
      );
      if (
        record.orderHash?.toLowerCase() === plan.orderHash?.toLowerCase() &&
        orderHash(components(record.protocolData?.parameters)) ===
          plan.orderHash
      )
        return nftJournal(
          "update",
          { ...operation, status: "accepted" },
          accessToken,
        );
    } catch {
      /* An absent response is not proof of rejection. */
    }
    return operation;
  }
  if (!operation.transactionHash || !plan.transaction) return operation;
  const rpc = provider(plan.scope);
  try {
    if (Number((await rpc.getNetwork()).chainId) !== plan.chainId)
      fail("The receipt service is on another chain.", 503);
    const [tx, receipt] = await Promise.all([
      rpc.getTransaction(operation.transactionHash),
      rpc.getTransactionReceipt(operation.transactionHash),
    ]);
    if (!tx || !receipt) {
      if (["confirmed", "failed"].includes(operation.status))
        return nftJournal(
          "update",
          { ...operation, status: "pending" },
          accessToken,
        );
      return operation;
    }
    assertTransactionBinding(tx, plan);
    const block = await rpc.getBlock(receipt.blockNumber);
    if (
      !block ||
      block.hash !== receipt.blockHash ||
      (await rpc.getBlockNumber()) - receipt.blockNumber + 1 < 2
    ) {
      if (["confirmed", "failed"].includes(operation.status))
        return nftJournal(
          "update",
          { ...operation, status: "pending" },
          accessToken,
        );
      return operation;
    }
    if (receipt.status !== 1) {
      if (operation.status === "failed") return operation;
      if (operation.status === "confirmed")
        operation = await nftJournal(
          "update",
          { ...operation, status: "pending" },
          accessToken,
        );
      return nftJournal(
        "update",
        { ...operation, status: "failed" },
        accessToken,
      );
    }
    if (plan.kind === "transaction") {
      const expected =
        plan.request.action === "cancel" ? "OrderCancelled" : "OrderFulfilled";
      const event = receipt.logs.some((log) => {
        if (!equalAddress(log.address, SEAPORT)) return false;
        try {
          const parsed = seaportABI.parseLog(log);
          return (
            parsed?.name === expected &&
            String(parsed.args.orderHash).toLowerCase() ===
              plan.orderHash?.toLowerCase() &&
            (expected === "OrderCancelled" ||
              equalAddress(parsed.args.recipient, plan.request.account))
          );
        } catch {
          return false;
        }
      });
      if (!event)
        fail(
          "The successful receipt does not contain the expected NFT order event.",
          409,
        );
    }
    if (operation.status === "confirmed") return operation;
    if (operation.status === "failed")
      operation = await nftJournal(
        "update",
        { ...operation, status: "pending" },
        accessToken,
      );
    return nftJournal(
      "update",
      { ...operation, status: "confirmed" },
      accessToken,
    );
  } finally {
    rpc.destroy();
  }
}
export function publicOrder(
  value: unknown,
  scope: NftScope,
  tokenId: string,
  side: "listing" | "offer",
  sourceURL?: string,
): NftOrderView | null {
  try {
    const raw = object(value),
      p = components(object(raw.protocolData).parameters);
    const nft = side === "listing" ? p.offer[0] : p.consideration[0];
    if (
      !equalAddress(nft.token, scope.contract) ||
      nft.identifierOrCriteria !== tokenId
    )
      return null;
    const pay = side === "listing" ? p.consideration : p.offer;
    if (
      pay.some(
        (value) =>
          value.itemType !== (side === "listing" ? 0 : 1) ||
          !equalAddress(
            value.token,
            side === "listing"
              ? "0x0000000000000000000000000000000000000000"
              : WETH[scope.chain],
          ) ||
          value.identifierOrCriteria !== "0",
      )
    )
      return null;
    const price =
      side === "listing"
        ? p.consideration.reduce(
            (sum, item) => sum + BigInt(item.startAmount),
            0n,
          )
        : BigInt(p.offer[0].startAmount);
    return {
      hash: orderHash(p),
      side,
      maker: p.offerer,
      quantity: nft.startAmount,
      priceWei: price.toString(),
      currency: side === "listing" ? "ETH" : "WETH",
      expiresAt: Number(p.endTime),
      status: String(raw.status || "observed"),
      ...(sourceURL ? { sourceURL } : {}),
    };
  } catch {
    return null;
  }
}
export async function reviewNftOperation(
  operation: NftOperation,
  session: UserSession,
) {
  requireNftTrading();
  const plan = checkCurrentPlan(operation, session);
  if (operation.status !== "awaiting-wallet")
    fail(
      "This operation already has a submitted result. Check its status.",
      409,
    );
  if (operation.walletStarted)
    fail(
      "A wallet request was already started. Reconcile it before another request.",
      409,
    );
  const rpc = provider(plan.scope);
  try {
    const canonical = plan.request.orderHash
      ? await canonicalOrder(nftAPI(plan.scope), plan.request, plan.scope)
      : undefined;
    await chainEligibility(rpc, plan.scope, plan.request, canonical?.p);
    if (plan.typedData) {
      const p = validateTypedData(plan.typedData, plan.request, plan.scope);
      const market = new Contract(SEAPORT, SeaportABI, rpc);
      if (String(await market.getCounter(plan.request.account)) !== p.counter)
        fail("The wallet order counter changed. Prepare a fresh order.", 409);
    }
    return operation;
  } finally {
    rpc.destroy();
  }
}
