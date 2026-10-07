/**
 * Which page a deployed asset belongs to — `AGENTS.md` §5, `ACCEPTANCE.md` §3.
 *
 * `AssetDetail` is one component shared by every slug in `lib/catalog.ts`: six invented artworks
 * that map to no deployed token. A settlement surface that read its contract from the environment
 * alone would therefore appear beneath all six titles at once, each page offering the same real
 * holding under a different artwork's name. A holder could then authorize a sale of an asset other
 * than the one the page describes — which is not only a fixture dressed as live data (`AGENTS.md`
 * §5, `ACCEPTANCE.md` §3), but a signature over terms the signer did not mean.
 *
 * So a deployment names the one slug it belongs to, and this decides, for a given page, which of
 * three things is true:
 *
 *   - **bound** — this page is that slug, so the deployment's addresses apply here;
 *   - **elsewhere** — a deployment exists and belongs to another page, which the page says rather
 *     than leaving the reader to infer that nothing is deployed at all;
 *   - **neither** — nothing is deployed, and the surface is simply unconfigured.
 *
 * Nothing here is a fallback to "show it anyway". An unnamed or mismatched slug never yields
 * `bound`, so the default for every route that is not the named one is inert.
 */

export type AssetBinding = {
  /** The deployment applies to this page. */
  bound: boolean;
  /** A deployment exists, and belongs to a different page. */
  boundElsewhere: boolean;
};

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function assetDeploymentBinding(
  /** The slug of the page asking. */
  slug: string | undefined,
  /** The slug the deployment names. */
  boundSlug: string | undefined,
  /** Whether a deployment address is configured at all. */
  configured: string | undefined,
): AssetBinding {
  const named = present(boundSlug);
  const here = present(slug);
  const deployed = present(configured) !== undefined;

  // A deployment that names no slug belongs to no page. Treating it as belonging to all of them is
  // the defect this function exists to prevent, so an unnamed deployment binds nowhere and is not
  // reported as being elsewhere either — there is no "elsewhere" to point at.
  if (!deployed || named === undefined) {
    return { bound: false, boundElsewhere: false };
  }
  if (here !== undefined && named === here) {
    return { bound: true, boundElsewhere: false };
  }
  return { bound: false, boundElsewhere: true };
}
