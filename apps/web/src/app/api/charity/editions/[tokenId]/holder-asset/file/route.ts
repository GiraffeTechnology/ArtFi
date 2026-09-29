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
import { fetchHolderObject } from "@/lib/charity-object-store";

/**
 * The holder benefit itself — #110 §2 CH.5.
 *
 * The sibling route describes what a verified holder will receive; this one hands it over. They are
 * deliberately separate: the description is safe to render on a page, and the bytes are fetched
 * only when the holder asks for them.
 *
 * Both routes run the same two gates in the same order — a grant that covers *this* edition, then a
 * descriptor that passes the master boundary — so widening one cannot silently widen the other.
 * This route adds the third: the object's own digest must match the descriptor before a byte is
 * written. Nothing partial is ever emitted.
 */

async function configuredResolver(): Promise<HolderAssetResolver> {
  const source = process.env.ARTFI_CHARITY_HOLDER_ASSET_MANIFEST?.trim();
  if (!source) {
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
  const delivery = await fetchHolderObject(asset);
  if (!delivery.ok) {
    if (delivery.refusal === "not-configured") {
      return NextResponse.json(
        {
          detail:
            "Watermarked holder delivery is not configured in this environment.",
          refusal: delivery.refusal,
        },
        { status: 503 },
      );
    }
    if (delivery.refusal === "unreachable") {
      return NextResponse.json(
        {
          detail: "The holder file could not be read.",
          refusal: "unreachable",
        },
        { status: 503 },
      );
    }
    // A digest or size that disagrees with the reviewed descriptor is a content fault. It is
    // reported as one rather than served with a warning, because the object may be a master.
    return NextResponse.json(
      {
        detail:
          "The stored file did not match its reviewed descriptor and was not served.",
        refusal: delivery.refusal,
      },
      { status: 409 },
    );
  }

  return new NextResponse(delivery.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(delivery.bytes.byteLength),
      "Cache-Control": "no-store",
      // Never rendered inline: a browser-displayed object is exactly what CH.6 keeps out.
      "Content-Disposition": `attachment; filename="artfi-charity-edition-${asset.tokenId}-watermarked"`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
