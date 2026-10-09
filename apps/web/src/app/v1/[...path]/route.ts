import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";

export const dynamic = "force-dynamic";
const publicRead =
  /^(?:config|assets(?:\/[a-zA-Z0-9_-]+)?|projects|nfts|market\/(?:assets|activity)|governance\/(?:config|proposals)|orders(?:\/(?:fraction-book|0x[0-9a-fA-F]{64}))?)$/;

/** Standalone installs retain same-origin public reads without a separately assembled proxy. */
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const endpoint = path.join("/");
  if (!publicRead.test(endpoint))
    return Response.json(
      { detail: "Public route not found." },
      { status: 404 },
    );
  try {
    const url = nativeOrderAPIURL(`v1/${endpoint}`);
    url.search = new URL(request.url).search;
    const upstream = await fetch(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const body = await boundedOrderText(upstream.body, 2 * 1024 * 1024);
    const data: unknown = JSON.parse(body);
    return Response.json(data, {
      status: upstream.status,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { detail: "The configured ArtFi data service is unavailable." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
