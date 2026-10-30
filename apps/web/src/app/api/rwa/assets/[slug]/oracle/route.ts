import { readRwaAsset } from "@/lib/rwa-catalog-server";
import { RwaCatalogError } from "@/lib/rwa-catalog";
import { readWholeArtworkOracle } from "@/lib/oracle-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  // This is an asset-bound read, not a generic proxy. No caller-supplied path,
  // URL, token, credentials, or query parameters reach the upstream service.
  if (new URL(request.url).search) {
    return Response.json(
      { ok: false, code: "UNKNOWN_ASSET" },
      { status: 400, headers },
    );
  }
  const { slug } = await context.params;
  let result;
  try {
    const asset = await readRwaAsset(slug);
    result = await readWholeArtworkOracle(slug, asset.binding);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        code:
          error instanceof RwaCatalogError && error.status === 404
            ? "UNKNOWN_ASSET"
            : "ORACLE_UNAVAILABLE",
      },
      {
        status: error instanceof RwaCatalogError ? error.status : 503,
        headers,
      },
    );
  }
  const status = result.ok
    ? 200
    : result.code === "UNKNOWN_ASSET"
      ? 404
      : result.code === "BINDING_MISMATCH"
        ? 502
        : result.code === "TOKEN_NOT_FOUND" || result.code === "ASSET_NOT_FOUND"
          ? 404
          : result.code === "ORACLE_RECORD_GONE"
            ? 410
            : 503;
  return Response.json(result, { status, headers });
}
