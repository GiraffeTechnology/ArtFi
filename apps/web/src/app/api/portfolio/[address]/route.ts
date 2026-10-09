import { isAddress } from "viem";
import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";
import { requireUserSession, UserAuthError } from "@/lib/user-auth";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

export async function GET(
  request: Request,
  context: { params: Promise<{ address: string }> },
) {
  const { address } = await context.params;
  if (!isAddress(address) || new URL(request.url).search)
    return Response.json(
      { detail: "Invalid portfolio request." },
      { status: 400, headers },
    );
  try {
    const { accessToken } = await requireUserSession(address);
    const response = await fetch(
      nativeOrderAPIURL(`/v1/portfolio/${address.toLowerCase()}`),
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Portfolio unavailable.");
    }
    const data = JSON.parse(
      await boundedOrderText(response.body, 2 * 1024 * 1024),
    );
    if (
      data?.address?.toLowerCase() !== address.toLowerCase() ||
      data.chainId !== 560048 ||
      !Array.isArray(data.positions) ||
      !Array.isArray(data.transactions)
    )
      throw new Error("Portfolio identity mismatch.");
    return Response.json(data, { headers });
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 503;
    return Response.json(
      {
        detail:
          status === 401 || status === 403
            ? "Sign in with this wallet to view its holdings and history."
            : "Portfolio records are unavailable.",
      },
      { status, headers },
    );
  }
}
