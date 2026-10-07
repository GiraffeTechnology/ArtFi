import { parseXionganWalletURL } from "@/lib/xiongan-wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read-only public configuration. No upstream request or user input is used. */
export async function GET() {
  const result = parseXionganWalletURL(process.env.ARTFI_XIONGAN_WALLET_URL);
  return Response.json(result, {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
