import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  resolveHolderAsset,
  type HolderAssetResolver,
} from "@/lib/charity-assets";
import {
  canonicalTokenId,
  grantCoversEdition,
  holderGrantCookie,
  readHolderGrant,
} from "@/lib/charity-holder-auth";

/**
 * Gated delivery of the watermarked holder file — #110 §2 CH.5 and CH.6.
 *
 * This handler resolves a descriptor and returns its location; it never streams a caller-named
 * object and never falls back. Every refusal below produces no bytes.
 */

async function configuredResolver(): Promise<HolderAssetResolver> {
  const source = process.env.ARTFI_CHARITY_HOLDER_ASSET_MANIFEST?.trim();
  if (!source) {
    // No reviewed descriptor store configured. Nothing is served, and nothing is invented.
    return async () => undefined;
  }
  const parsed = JSON.parse(source) as Record<string, unknown>;
  return async (tokenId: string) => parsed[tokenId];
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ tokenId: string }> },
) {
  const { tokenId: rawTokenId } = await context.params;
  const tokenId = canonicalTokenId(rawTokenId);
  if (!tokenId) {
    return NextResponse.json(
      { detail: "Unknown charity edition." },
      { status: 404 },
    );
  }

  const cookieStore = await cookies();
  const grant = readHolderGrant(cookieStore.get(holderGrantCookie)?.value);
  if (!grantCoversEdition(grant, tokenId)) {
    // A grant for another edition is no better than no grant at all.
    return NextResponse.json(
      {
        detail:
          "Verify ownership of this charity edition to receive the watermarked file.",
      },
      { status: 401 },
    );
  }

  let decision;
  try {
    decision = await resolveHolderAsset(tokenId, await configuredResolver());
  } catch {
    return NextResponse.json(
      { detail: "Charity holder delivery is unavailable." },
      { status: 503 },
    );
  }

  if (!decision.ok) {
    if (decision.refusal === "unknown-edition") {
      return NextResponse.json(
        { detail: "Unknown charity edition." },
        { status: 404 },
      );
    }
    // A descriptor that fails the master boundary is a configuration fault, reported as such
    // rather than degraded into something servable.
    return NextResponse.json(
      {
        detail:
          "The holder file for this edition failed the master boundary and was not served.",
        refusal: decision.refusal,
      },
      { status: 409 },
    );
  }

  const { asset } = decision;
  return NextResponse.json(
    {
      tokenId: asset.tokenId,
      class: asset.class,
      contentType: asset.contentType,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      objectKey: asset.objectKey,
      artworkPreview: "not-provided",
      rights:
        "This edition conveys no copyright, physical title, possession, redemption, commercial-use or reproduction right.",
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        // The holder file is never rendered inline by a browser.
        "Content-Disposition": `attachment; filename="charity-edition-${asset.tokenId}"`,
      },
    },
  );
}
