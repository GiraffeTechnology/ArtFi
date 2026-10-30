import { readRwaAsset } from "@/lib/rwa-catalog-server";
import { RwaCatalogError } from "@/lib/rwa-catalog";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    if (new URL(request.url).search)
      throw new RwaCatalogError(400, "Unexpected asset-detail query.");
    return Response.json(await readRwaAsset((await context.params).slug), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        detail:
          error instanceof RwaCatalogError
            ? error.message
            : "The asset record is unavailable.",
      },
      {
        status: error instanceof RwaCatalogError ? error.status : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
