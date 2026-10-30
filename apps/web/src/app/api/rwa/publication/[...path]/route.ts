import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";
import {
  assertUserRequestOrigin,
  requireUserSession,
  UserAuthError,
} from "@/lib/user-auth";
import {
  rwaPublicationAssetSchema,
  rwaPublicationPath,
  rwaPublicationSchema,
} from "@/lib/rwa-publication";
import { rwaAssetSchema } from "@/lib/rwa-catalog";
export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };
const messages: Record<number, string> = {
  400: "The publication contains unsupported fields or an invalid request key.",
  401: "Sign in with the current wallet to continue.",
  403: "The request origin or wallet session is not authorized.",
  404: "Unknown source-publication route.",
  409: "The source proof was revoked, its binding is already used, or the catalog revision changed. Reload the public record before editing.",
  413: "The public metadata or evidence envelope is too large.",
  422: "The approved source signature, rights, validity or exact asset binding could not be verified.",
};
async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    const upstream = rwaPublicationPath(path, request.method);
    if (!upstream || new URL(request.url).search)
      throw new UserAuthError(404, "Unknown route.");
    assertUserRequestOrigin(request);
    const wallet = request.headers.get("x-artfi-wallet") || "";
    const chain = Number(request.headers.get("x-artfi-chain"));
    if (chain !== 560048)
      throw new UserAuthError(401, "A supported wallet session is required.");
    const { accessToken } = await requireUserSession(wallet, chain);
    let input: unknown;
    try {
      input = JSON.parse(await boundedOrderText(request.body, 64000));
    } catch {
      throw new UserAuthError(413, "Invalid public envelope.");
    }
    const parsed =
      request.method === "PUT"
        ? rwaPublicationSchema.safeParse(input)
        : rwaPublicationAssetSchema.safeParse(input);
    if (!parsed.success)
      throw new UserAuthError(400, "Unsupported public envelope fields.");
    if (
      request.method === "PUT" &&
      (parsed.data as { asset: { slug: string } }).asset.slug !== path[1]
    )
      throw new UserAuthError(400, "Asset identity mismatch.");
    const key = request.headers.get("idempotency-key") || "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key))
      throw new UserAuthError(400, "Request key required.");
    const response = await fetch(nativeOrderAPIURL(upstream), {
      method: request.method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UserAuthError(
        messages[response.status] ? response.status : 503,
        "Source verification unavailable.",
      );
    }
    const result: unknown = JSON.parse(
      await boundedOrderText(response.body, 100000),
    );
    if (request.method === "PUT")
      return Response.json(rwaAssetSchema.parse(result), {
        status: response.status,
        headers,
      });
    const draft = result as Record<string, unknown>;
    if (
      draft.executable !== false ||
      typeof draft.contextHash !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(draft.contextHash)
    )
      throw new Error("Invalid unsigned source commitment");
    return Response.json(
      {
        asset: rwaPublicationAssetSchema.parse(draft.asset),
        contextHash: draft.contextHash,
        executable: false,
      },
      { headers },
    );
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail:
          messages[status] ||
          "Source verification is unavailable. No publication was confirmed. Retry the same request when available.",
      },
      { status, headers },
    );
  }
}
export const POST = proxy;
export const PUT = proxy;
