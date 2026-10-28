import { readSourceBoundNativeAnalytics } from "@/lib/native-market-analytics-server";
import { NativeAnalyticsError } from "@/lib/native-market-analytics";
import { RwaCatalogError } from "@/lib/rwa-catalog";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const query = new URL(request.url).searchParams;
  if (
    [...query.keys()].length !== 1 ||
    query.getAll("paymentToken").length !== 1 ||
    !/^0x[0-9a-fA-F]{40}$/.test(query.get("paymentToken") ?? "") ||
    /^0x0{40}$/i.test(query.get("paymentToken")!)
  )
    return Response.json(
      { detail: "Supply exactly one nonzero payment-token address." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  try {
    return Response.json(
      await readSourceBoundNativeAnalytics(
        (await context.params).slug,
        query.get("paymentToken")!,
        request.signal,
      ),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const status =
      error instanceof RwaCatalogError
        ? error.status
        : error instanceof NativeAnalyticsError &&
            error.reason === "unsupported"
          ? 422
          : error instanceof NativeAnalyticsError && error.reason === "scope"
            ? 400
            : 503;
    return Response.json(
      {
        detail:
          error instanceof NativeAnalyticsError
            ? error.message
            : "Source-bound indexed analytics are unavailable.",
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
