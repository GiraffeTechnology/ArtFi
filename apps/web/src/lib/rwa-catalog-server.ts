import "server-only";
import { boundedOrderText, nativeOrderAPIURL } from "./native-order-upstream";
import {
  rwaAssetSchema,
  rwaCatalogPageSchema,
  rwaCatalogQuery,
  rwaSlugSchema,
  RwaCatalogError,
} from "./rwa-catalog";
async function read(path: string) {
  try {
    const response = await fetch(nativeOrderAPIURL(path), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new RwaCatalogError(
        response.status === 404 ? 404 : 503,
        response.status === 404
          ? "This asset is not in the approved-source catalog."
          : "The approved-source asset catalog is unavailable.",
      );
    }
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") || "",
      )
    )
      throw new Error("Invalid content type");
    return JSON.parse(
      await boundedOrderText(response.body, 1024 * 1024),
    ) as unknown;
  } catch (error) {
    if (error instanceof RwaCatalogError) throw error;
    throw new RwaCatalogError(
      503,
      "The approved-source asset catalog is unavailable.",
    );
  }
}
export async function readRwaCatalog(input: URLSearchParams) {
  const query = rwaCatalogQuery(input);
  const raw = await read(`/v1/rwa/assets?${query}`);
  const parsed = rwaCatalogPageSchema.safeParse(raw);
  if (!parsed.success)
    throw new RwaCatalogError(
      503,
      "The asset catalog returned an invalid record.",
    );
  const section = query.get("section");
  if (section && parsed.data.data.some((asset) => asset.section !== section))
    throw new RwaCatalogError(
      503,
      "The asset catalog returned another product section.",
    );
  return parsed.data;
}
export async function readRwaAsset(slug: string) {
  if (!rwaSlugSchema.safeParse(slug).success)
    throw new RwaCatalogError(
      404,
      "This asset is not in the approved-source catalog.",
    );
  const parsed = rwaAssetSchema.safeParse(
    await read(`/v1/rwa/assets/${encodeURIComponent(slug)}`),
  );
  if (!parsed.success || parsed.data.slug !== slug)
    throw new RwaCatalogError(
      503,
      "The asset catalog returned a different or invalid binding.",
    );
  return parsed.data;
}
