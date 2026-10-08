import { isAddress } from "viem";
import { decodeNativeOrder } from "@/lib/native-order";
import {
  boundedOrderText,
  nativeOrderAPIURL,
  nativeOrderResponse,
} from "@/lib/native-order-upstream";
import {
  verifyNativeOrderSale,
  OrderVerificationUnavailable,
} from "@/lib/native-order-verification";
import { requireUserSession, UserAuthError } from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const allowedFilters = new Set([
  "kind",
  "chainId",
  "marketAddress",
  "assetAddress",
  "tokenId",
  "sellerAddress",
  "page",
  "pageSize",
]);
const uint256Max = (1n << 256n) - 1n;

function validQuery(query: URLSearchParams) {
  for (const key of query.keys()) {
    const values = query.getAll(key);
    if (!allowedFilters.has(key) || values.length !== 1 || !values[0])
      return false;
    const value = values[0];
    if (key.endsWith("Address") && !isAddress(value)) return false;
    if (key === "chainId" && value !== "560048") return false;
    if (key === "kind" && !["whole", "fraction"].includes(value)) return false;
    if (
      key === "tokenId" &&
      (!/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > uint256Max)
    )
      return false;
    if (
      ["page", "pageSize"].includes(key) &&
      (!/^[1-9][0-9]*$/.test(value) ||
        Number(value) > (key === "pageSize" ? 100 : 1000000))
    )
      return false;
  }
  return true;
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  if (!validQuery(query))
    return Response.json({ detail: "Invalid order filters." }, { status: 400 });
  try {
    const upstream = nativeOrderAPIURL(`/v1/orders?${query.toString()}`);
    return await nativeOrderResponse(
      await fetch(upstream, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
    );
  } catch {
    return Response.json(
      { detail: "The order service is unavailable." },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const configured = process.env.ARTFI_WEB_URL?.trim();
    if (!configured)
      return Response.json(
        { detail: "Publication is unavailable." },
        { status: 503 },
      );
    const authority = new URL(configured);
    const origin = authority.origin;
    const host = request.headers.get("host");
    // `authority.host` is the configured authority exactly as configured: it carries the port when
    // the configured URL names one and carries none when it does not. No default port is assumed.
    //
    // This used to fall back to the default HTTPS port when the configured URL named none: a
    // port-less configuration then accepted the bare host and that implied port and rejected every
    // other, so a deployment serving on any other port answered 403 here with nothing naming the
    // cause. Where the deployment host reserves that default port for something else, the fallback
    // also pinned the deployment to a port it could never use. A deployment that serves on a port
    // now names it in the configuration, and a mismatch is a visible configuration fault rather
    // than a fallback that quietly accepts the wrong authority.
    //
    // NextRequest normalizes loopback URLs, and a reverse proxy may use an internal URL.
    // The proxy must preserve the public Host. Forwarded headers are not trusted here.
    const publicHostMatches =
      host === null
        ? new URL(request.url).origin === origin
        : host.toLowerCase() === authority.host.toLowerCase();
    if (
      !publicHostMatches ||
      request.headers.get("origin") !== origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return Response.json(
        { detail: "Publication requires the application's own origin." },
        { status: 403 },
      );
    const verifierKey = process.env.ARTFI_INDEXER_SHARED_KEY?.trim();
    if (!verifierKey)
      return Response.json(
        { detail: "Publication is unavailable." },
        { status: 503 },
      );
    let raw: string;
    try {
      raw = await boundedOrderText(request.body, 32768);
    } catch {
      return Response.json(
        { detail: "The order payload exceeds the supported size." },
        { status: 413 },
      );
    }
    let order;
    try {
      const body: unknown = JSON.parse(raw);
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("order" in body)
      )
        throw new Error("Unsupported publication fields.");
      order = decodeNativeOrder(body.order).order;
      // Publication time is server-owned and cannot change immutable retry identity.
      delete order.createdAt;
    } catch {
      return Response.json(
        { detail: "The signed order is malformed." },
        { status: 400 },
      );
    }
    const { accessToken } = await requireUserSession(
      String(order.intent.seller),
    );
    try {
      await verifyNativeOrderSale(order);
    } catch (error) {
      if (error instanceof OrderVerificationUnavailable)
        return Response.json(
          { detail: "Sale verification is unavailable." },
          { status: 503 },
        );
      return Response.json(
        { detail: "The seller's sale signature is invalid." },
        { status: 401 },
      );
    }
    return await nativeOrderResponse(
      await fetch(nativeOrderAPIURL("/v1/indexer/signed-orders"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Indexer-Key": verifierKey,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(order),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
    );
  } catch (error) {
    if (error instanceof UserAuthError)
      return Response.json(
        { detail: "Sign in with the seller wallet." },
        { status: error.status },
      );
    return Response.json(
      { detail: "The order service is unavailable." },
      { status: 503 },
    );
  }
}
