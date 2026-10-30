import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";
import {
  assertUnderlyingStatus,
  underlyingIdentityQuery,
} from "@/lib/rwa-underlying";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
export async function GET(request: Request) {
  let identity;
  try {
    identity = underlyingIdentityQuery(new URL(request.url).searchParams);
  } catch {
    return Response.json(
      { detail: "Use only the exact supported underlying identity." },
      { status: 400, headers },
    );
  }
  try {
    const url = nativeOrderAPIURL("/v1/rwa/underlying-status");
    url.search = new URLSearchParams({
      chainId: String(identity.chainId),
      collectionAddress: identity.collectionAddress,
      tokenId: identity.tokenId,
    }).toString();
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json(
        {
          detail:
            response.status === 409
              ? "The underlying has no current approved-source correspondence."
              : "Underlying source verification is unavailable.",
        },
        { status: response.status === 409 ? 409 : 503, headers },
      );
    }
    const result = assertUnderlyingStatus(
      JSON.parse(await boundedOrderText(response.body, 16384)),
      identity,
    );
    return Response.json(result, { headers });
  } catch {
    return Response.json(
      { detail: "Underlying source verification is unavailable." },
      { status: 503, headers },
    );
  }
}
