import {
  assertUserRequestOrigin,
  readBoundedJSON,
  requireUserSession,
  UserAuthError,
} from "@/lib/user-auth";
import { nftScopes, nftScope, requireNftTrading } from "@/lib/nft/config";
import { nftAPI, safeNft } from "@/lib/nft/venue";
import {
  NFT_CHAINS,
  NftError,
  object,
  readNftRequest,
  uint,
  equalAddress,
} from "@/lib/nft/model";
import { components, sdkChain } from "@/lib/nft/validation";
import { nftJournal, nftOperationHistory } from "@/lib/nft/journal";
import {
  prepareNftOperation,
  submitNftSignature,
  recordNftTransaction,
  reconcileNftOperation,
  reviewNftOperation,
  publicOrder,
} from "@/lib/nft/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ action: string }> };
function output(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
function errorResult(error: unknown) {
  const known = error instanceof NftError || error instanceof UserAuthError;
  return output(
    {
      detail: known
        ? error.message
        : "The NFT service is unavailable. Try again later.",
    },
    known ? error.status : 503,
  );
}
export async function GET(request: Request, context: Context) {
  try {
    const { action } = await context.params;
    const query = new URL(request.url).searchParams;
    if (action === "config") {
      let enabled = true;
      try {
        requireNftTrading();
      } catch {
        enabled = false;
      }
      return output({
        collections: nftScopes(),
        tradingEnabled: enabled,
        chainIds: NFT_CHAINS,
      });
    }
    if (action === "history") {
      if (
        [...query.keys()].some(
          (key) =>
            !["account", "chainId", "page"].includes(key) ||
            query.getAll(key).length !== 1,
        ) ||
        !/^(1|8453)$/.test(query.get("chainId") || "") ||
        !/^[1-9][0-9]{0,5}$/.test(query.get("page") || "1")
      )
        throw new NftError(400, "Invalid NFT history query.");
      const auth = await requireUserSession(
        query.get("account") || "",
        Number(query.get("chainId")),
      );
      const history = await nftOperationHistory(
        auth.accessToken,
        Number(query.get("page") || 1),
      );
      if (
        !equalAddress(history.wallet, auth.session.address) ||
        history.chainId !== auth.session.chainId
      )
        throw new NftError(
          503,
          "The NFT history belongs to another wallet or chain.",
        );
      return output(history);
    }
    if (!["catalog", "detail", "order", "owned"].includes(action))
      return output({ detail: "Unknown NFT route." }, 404);
    if (
      [...query.keys()].some(
        (key) =>
          ![
            "collection",
            "tokenId",
            "cursor",
            "orderHash",
            ...(action === "owned" ? ["account"] : []),
          ].includes(key),
      ) ||
      [...query.keys()].some((key) => query.getAll(key).length !== 1)
    )
      throw new NftError(400, "Invalid NFT query.");
    const scope = nftScope(query.get("collection") || "");
    // Wallet holdings are private even though the venue's collection catalog is public.
    const owner =
      action === "owned"
        ? await requireUserSession(
            query.get("account") || "",
            NFT_CHAINS[scope.chain],
          )
        : undefined;
    const api = nftAPI(scope);
    if (owner) {
      const cursor = query.get("cursor") || undefined;
      if (cursor && (cursor.length > 2048 || /[\x00-\x1f]/.test(cursor)))
        throw new NftError(400, "Invalid holdings cursor.");
      const response = await api.nfts.getNFTsByAccount(
        owner.session.address,
        24,
        cursor,
        sdkChain(scope),
      );
      return output({
        wallet: owner.session.address,
        chainId: NFT_CHAINS[scope.chain],
        data: response.nfts
          .filter(
            (value) =>
              equalAddress(value.contract, scope.contract) &&
              value.collection === scope.slug &&
              value.tokenStandard === scope.standard,
          )
          .map((value) => safeNft(value, scope)),
        next: response.next || null,
        scope,
        observedAt: new Date().toISOString(),
        source: "opensea",
      });
    }
    if (action === "catalog") {
      const cursor = query.get("cursor") || undefined;
      if (cursor && (cursor.length > 2048 || /[\x00-\x1f]/.test(cursor)))
        throw new NftError(400, "Invalid catalog cursor.");
      const response = await api.nfts.getNFTsByCollection(
        scope.slug,
        24,
        cursor,
      );
      return output({
        data: response.nfts.map((value) => safeNft(value, scope)),
        next: response.next || null,
        scope,
        observedAt: new Date().toISOString(),
        source: "opensea",
      });
    }
    const tokenId = uint(query.get("tokenId"));
    if (action === "order") {
      const hash = query.get("orderHash") || "";
      if (!/^0x[a-fA-F0-9]{64}$/.test(hash))
        throw new NftError(400, "A valid order hash is required.");
      const raw = await api.orders.getOrderByHash(
        hash,
        "0x0000000000000068F116a894984e2DB1123eB395",
        sdkChain(scope),
      );
      const identity = await api.nfts.getNFT(
        scope.contract,
        tokenId,
        sdkChain(scope),
      );
      const nft = safeNft(identity.nft, scope);
      if (nft.tokenId !== tokenId)
        throw new NftError(503, "The venue returned a different NFT.");
      const terms = components(raw.protocolData?.parameters);
      const order = publicOrder(
        raw,
        scope,
        tokenId,
        terms.offer[0].itemType >= 2 ? "listing" : "offer",
        nft.sourceURL,
      );
      if (!order || order.hash.toLowerCase() !== hash.toLowerCase())
        throw new NftError(
          404,
          "This order is not a supported order for the selected NFT.",
        );
      return output({ order, observedAt: new Date().toISOString() });
    }
    const response = await api.nfts.getNFT(
      scope.contract,
      tokenId,
      sdkChain(scope),
    );
    const nft = safeNft(response.nft, scope);
    if (nft.tokenId !== tokenId)
      throw new NftError(503, "The venue returned a different NFT.");
    const [listing, offers] = await Promise.allSettled([
      api.listings.getBestListing(scope.slug, tokenId),
      api.offers.getOffersByNFT(scope.slug, tokenId, 50),
    ]);
    const orders = [];
    if (listing.status === "fulfilled") {
      const entry = publicOrder(
        listing.value,
        scope,
        tokenId,
        "listing",
        nft.sourceURL,
      );
      if (entry) orders.push(entry);
    }
    if (offers.status === "fulfilled")
      for (const raw of offers.value.offers) {
        const entry = publicOrder(raw, scope, tokenId, "offer", nft.sourceURL);
        if (entry) orders.push(entry);
      }
    const unavailable = [listing, offers].some(
      (result) =>
        result.status === "rejected" &&
        (!(result.reason instanceof NftError) || result.reason.status !== 404),
    );
    return output({
      nft,
      orders,
      ordersUnavailable: unavailable,
      scope,
      observedAt: new Date().toISOString(),
      source: "opensea",
    });
  } catch (error) {
    return errorResult(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    assertUserRequestOrigin(request);
    const { action } = await context.params;
    const body = object(await readBoundedJSON(request));
    if (
      ![
        "prepare",
        "review",
        "sign",
        "broadcast",
        "status",
        "abandon",
        "wallet-start",
        "wallet-rejected",
        "wallet-uncertain",
      ].includes(action)
    )
      return output({ detail: "Unknown NFT action." }, 404);
    const keys =
      action === "prepare"
        ? ["operationId", "request"]
        : action === "sign"
          ? ["operationId", "account", "chainId", "signature"]
          : action === "broadcast"
            ? ["operationId", "account", "chainId", "transactionHash"]
            : ["operationId", "account", "chainId"];
    if (
      Object.keys(body).some((key) => !keys.includes(key)) ||
      typeof body.operationId !== "string" ||
      !/^[a-zA-Z0-9_-]{16,80}$/.test(body.operationId)
    )
      throw new NftError(400, "Invalid NFT action payload.");
    if (action === "prepare") {
      const input = readNftRequest(body.request);
      const scope = nftScope(input.collection);
      const auth = await requireUserSession(
        input.account,
        NFT_CHAINS[scope.chain],
      );
      return output(
        await prepareNftOperation(
          body.operationId,
          input,
          scope,
          auth.session,
          auth.accessToken,
        ),
      );
    }
    if (typeof body.account !== "string" || typeof body.chainId !== "number")
      throw new NftError(400, "Select the wallet and chain first.");
    const auth = await requireUserSession(body.account, body.chainId);
    const operation = await nftJournal(
      "get",
      { id: body.operationId },
      auth.accessToken,
    );
    if (action === "wallet-start") {
      await reviewNftOperation(operation, auth.session);
      return output(
        await nftJournal(
          "update",
          { ...operation, walletStarted: true },
          auth.accessToken,
        ),
      );
    }
    if (action === "wallet-rejected" || action === "wallet-uncertain") {
      if (!operation.walletStarted || operation.status !== "awaiting-wallet")
        throw new NftError(409, "The wallet attempt cannot be changed.");
      return output(
        await nftJournal(
          "update",
          {
            ...operation,
            status:
              action === "wallet-rejected"
                ? "rejected"
                : operation.plan.kind === "signature"
                  ? "failed"
                  : "pending",
          },
          auth.accessToken,
        ),
      );
    }
    if (action === "abandon") {
      if (
        operation.status !== "awaiting-wallet" ||
        operation.transactionHash ||
        operation.walletStarted
      )
        throw new NftError(
          409,
          "A submitted operation cannot be discarded. Reconcile its result first.",
        );
      return output(
        await nftJournal(
          "update",
          { ...operation, status: "cancelled" },
          auth.accessToken,
        ),
      );
    }
    if (action === "review")
      return output(await reviewNftOperation(operation, auth.session));
    if (action === "sign") {
      if (typeof body.signature !== "string")
        throw new NftError(400, "A wallet signature is required.");
      return output(
        await submitNftSignature(
          operation,
          body.signature,
          auth.session,
          auth.accessToken,
        ),
      );
    }
    if (action === "broadcast") {
      if (typeof body.transactionHash !== "string")
        throw new NftError(400, "A transaction hash is required.");
      return output(
        await recordNftTransaction(
          operation,
          body.transactionHash,
          auth.session,
          auth.accessToken,
        ),
      );
    }
    return output(await reconcileNftOperation(operation, auth.accessToken));
  } catch (error) {
    return errorResult(error);
  }
}
