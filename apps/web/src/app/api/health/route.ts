export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    {
      chainId: 560048,
      buildRevision: /^[a-f0-9]{40}$/.test(process.env.ARTFI_BUILD_SHA ?? "")
        ? process.env.ARTFI_BUILD_SHA
        : null,
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
