import { serveTestNFTMetadata } from "@/lib/test-nft-metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ sha256: string }> },
) {
  const { sha256 } = await context.params;
  // Only the allowlisted content hash selects a file; no query selects a path or rendering.
  if (new URL(request.url).search) {
    return new Response(JSON.stringify({ detail: "Unknown test metadata." }), {
      status: 404,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  return serveTestNFTMetadata(sha256, {
    environment: process.env.ARTFI_ENV,
    chainId: process.env.ARTFI_CHAIN_ID,
    manifestPath: process.env.ARTFI_TEST_NFT_METADATA_MANIFEST,
  });
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ sha256: string }> },
) {
  const response = await GET(request, context);
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
