export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      chainId: 11155111,
      marketplaceMode: "external-mirror",
      service: "artfi-web",
      status: "ok",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
