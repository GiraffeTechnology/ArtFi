import "server-only";

/**
 * Charity-edition asset boundary — #110 §2 CH.6, CH.7 and CH.11.
 *
 * CH.6 is the rule this module exists to make true at runtime: the unwatermarked master never
 * enters public metadata, a website download, or any browser-delivered object. Until now that rule
 * lived only in a release manifest, which *declares* the posture — `ACCEPTANCE.md` §7.16 is explicit
 * that a declaration is not evidence that the runtime enforces it.
 *
 * The enforcement is structural rather than advisory:
 *
 *   - a caller never supplies a path. A token ID resolves through a configured descriptor, so there
 *     is no traversal that could reach a master object;
 *   - a descriptor is served only when it declares `class: "watermarked-holder"`. Any other class,
 *     including a missing one, is refused;
 *   - a descriptor whose digest equals the series master digest is refused even if it claims to be
 *     watermarked. That is CH.11 — master and holder file must hash differently — enforced at the
 *     moment of delivery rather than only at packaging time;
 *   - a descriptor carrying a preview URL is refused. CH.7 keeps previews out of public metadata,
 *     and a preview attached to the holder file would reintroduce one through the back door.
 *
 * Every check fails closed. There is no fallback object and no "serve it anyway" path: a
 * misconfigured descriptor yields no bytes.
 */

export type CharityHolderAsset = {
  /** Only this class is ever delivered. */
  class: string;
  tokenId: string;
  /** SHA-256 of the watermarked holder file. */
  sha256: string;
  /** SHA-256 of the master. Never served; held to prove the two differ. */
  masterSha256: string;
  contentType: string;
  byteLength: number;
  /** Where the watermarked object lives. Never public, never a browser-reachable URL. */
  objectKey: string;
  /** Must be absent. Present means the descriptor is refused. */
  previewUrl?: string;
};

export type AssetRefusal =
  | "unknown-edition"
  | "not-watermarked"
  | "master-digest-collision"
  | "preview-attached"
  | "malformed-descriptor";

export type AssetDecision =
  | { ok: true; asset: CharityHolderAsset }
  | { ok: false; refusal: AssetRefusal };

const sha256Pattern = /^[0-9a-f]{64}$/;
const allowedContentTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

export const watermarkedHolderClass = "watermarked-holder";

/**
 * The single gate every delivered byte passes through.
 *
 * Exported and pure so the refusal behaviour can be tested directly, including the cases that
 * matter most: a master mislabelled as a holder file, and a holder file whose digest collides with
 * the master's.
 */
export function decideHolderAsset(descriptor: unknown): AssetDecision {
  if (typeof descriptor !== "object" || descriptor === null) {
    return { ok: false, refusal: "unknown-edition" };
  }
  const candidate = descriptor as Partial<CharityHolderAsset>;

  if (
    typeof candidate.tokenId !== "string" ||
    typeof candidate.sha256 !== "string" ||
    typeof candidate.masterSha256 !== "string" ||
    typeof candidate.objectKey !== "string" ||
    typeof candidate.contentType !== "string" ||
    typeof candidate.byteLength !== "number" ||
    !sha256Pattern.test(candidate.sha256) ||
    !sha256Pattern.test(candidate.masterSha256) ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength <= 0 ||
    candidate.objectKey.length === 0 ||
    !allowedContentTypes.has(candidate.contentType)
  ) {
    return { ok: false, refusal: "malformed-descriptor" };
  }

  // A master mislabelled — or simply not labelled — is refused before anything else is considered.
  if (candidate.class !== watermarkedHolderClass) {
    return { ok: false, refusal: "not-watermarked" };
  }

  // CH.11 at delivery time. If the digests match, the "watermarked" file is the master.
  if (candidate.sha256.toLowerCase() === candidate.masterSha256.toLowerCase()) {
    return { ok: false, refusal: "master-digest-collision" };
  }

  // CH.7: no preview reaches a browser, not even bundled with the holder file.
  if (candidate.previewUrl !== undefined) {
    return { ok: false, refusal: "preview-attached" };
  }

  return { ok: true, asset: candidate as CharityHolderAsset };
}

export type HolderAssetResolver = (
  tokenId: string,
) => Promise<unknown | undefined>;

/**
 * Resolve and gate in one step. The resolver is injectable: in TEST_ONLY runs it returns fixtures,
 * and in a deployed environment it reads the reviewed descriptor store. Neither path lets a caller
 * name an object.
 */
export async function resolveHolderAsset(
  tokenId: string,
  resolve: HolderAssetResolver,
): Promise<AssetDecision> {
  const descriptor = await resolve(tokenId);
  if (descriptor === undefined)
    return { ok: false, refusal: "unknown-edition" };
  const decision = decideHolderAsset(descriptor);
  if (decision.ok && decision.asset.tokenId !== tokenId) {
    // A descriptor that answers for a different edition is a configuration fault, not a fallback.
    return { ok: false, refusal: "unknown-edition" };
  }
  return decision;
}

/** Public-facing copy of an edition. CH.7: this shape has nowhere to put a preview or a master. */
export type CharityEditionPublicView = {
  tokenId: string;
  editionsPerArtwork: number;
  primaryPriceWei: string;
  artworkPreview: "not-provided";
  holderBenefit: "watermarked-copy-after-ownership-verification";
};

export function publicEditionView(tokenId: string): CharityEditionPublicView {
  return {
    tokenId,
    editionsPerArtwork: 100,
    primaryPriceWei: "10000000000000000",
    artworkPreview: "not-provided",
    holderBenefit: "watermarked-copy-after-ownership-verification",
  };
}
