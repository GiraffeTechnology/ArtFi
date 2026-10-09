import { isAddress } from "viem";
import {
  boundedOrderText,
  nativeOrderAPIURL,
} from "@/lib/native-order-upstream";

export const dynamic = "force-dynamic";

/** Public immutable candidates only. No wallet, session, or chain execution is performed here. */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const keys = [
    "chainId",
    "marketAddress",
    "assetAddress",
    "paymentToken",
    "at",
  ];
  if (
    [...query.keys()].length !== keys.length ||
    keys.some((key) => query.getAll(key).length !== 1) ||
    query.get("chainId") !== "560048" ||
    keys.slice(1, 4).some((key) => !isAddress(query.get(key) ?? "")) ||
    !/^(0|[1-9][0-9]{0,14})$/.test(query.get("at") ?? "") ||
    BigInt(query.get("at")!) >= 1n << 48n
  )
    return Response.json(
      { detail: "Invalid fraction book scope." },
      { status: 400 },
    );
  try {
    const upstream = await fetch(
      nativeOrderAPIURL(`/v1/orders/fraction-book?${query}`),
      {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!upstream.ok)
      return Response.json(
        {
          detail:
            upstream.status === 422
              ? "The token pair exceeds the supported book snapshot. No partial order log was matched."
              : "The fraction order book is unavailable.",
        },
        { status: upstream.status === 422 ? 422 : 503 },
      );
    const raw = await boundedOrderText(upstream.body, 12 * 1024 * 1024);
    return Response.json(JSON.parse(raw), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json(
      { detail: "The fraction order book is unavailable." },
      { status: 503 },
    );
  }
}
