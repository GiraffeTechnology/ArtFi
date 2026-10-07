import { isAddress } from "viem";
import {
  nativeOrderAPIURL,
  nativeOrderResponse,
} from "@/lib/native-order-upstream";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ intentHash: string }> },
) {
  const { intentHash } = await context.params;
  const query = new URL(request.url).searchParams;
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(intentHash) ||
    [...query.keys()].length !== 2 ||
    query.getAll("chainId").length !== 1 ||
    query.getAll("marketAddress").length !== 1 ||
    query.get("chainId") !== "560048" ||
    !isAddress(query.get("marketAddress") ?? "")
  )
    return Response.json(
      { detail: "The linked order requires an exact hash, chain and market." },
      { status: 400 },
    );
  try {
    const upstream = nativeOrderAPIURL(
      `/v1/orders/${intentHash.toLowerCase()}?${query.toString()}`,
    );
    return await nativeOrderResponse(
      await fetch(upstream, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
    );
  } catch {
    return Response.json(
      { detail: "The order service is unavailable." },
      { status: 503 },
    );
  }
}
