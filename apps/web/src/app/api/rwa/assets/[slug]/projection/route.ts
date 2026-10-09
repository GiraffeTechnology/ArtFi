import { readRwaAsset } from "@/lib/rwa-catalog-server";
import { RwaCatalogError } from "@/lib/rwa-catalog";
import { readWholeArtworkProjection } from "@/lib/oracle-projection";

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
  const query = new URL(request.url).searchParams;
  if (
    [...query.keys()].some((key) => key !== "instant") ||
    query.getAll("instant").length !== 1
  ) {
    return Response.json(
      { ok: false, code: "INSTANT_INVALID" },
      { status: 400, headers },
    );
  }
  const { slug } = await context.params;
  let result;
  try {
    const asset = await readRwaAsset(slug);
    result = await readWholeArtworkProjection(
      slug,
      query.get("instant")!,
      asset.binding,
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        code:
          error instanceof RwaCatalogError && error.status === 404
            ? "UNKNOWN_ASSET"
            : "PROJECTION_READ_UNAVAILABLE",
      },
      {
        status: error instanceof RwaCatalogError ? error.status : 503,
        headers,
      },
    );
  }
  const status = result.ok
    ? 200
    : result.code === "INSTANT_INVALID"
      ? 400
      : result.code === "UNKNOWN_ASSET" || result.code === "UNKNOWN_TOKEN"
        ? 404
        : result.code === "PROJECTION_BINDING_MISMATCH" ||
            result.code === "PROJECTION_SOURCE_MALFORMED"
          ? 502
          : 503;
  return Response.json(result, { status, headers });
}
