import { readRwaCatalog } from "@/lib/rwa-catalog-server";
import { RwaCatalogError } from "@/lib/rwa-catalog";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return Response.json(
      await readRwaCatalog(new URL(request.url).searchParams),
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        detail:
          error instanceof RwaCatalogError
            ? error.message
            : "The asset catalog is unavailable.",
      },
      {
        status: error instanceof RwaCatalogError ? error.status : 503,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
