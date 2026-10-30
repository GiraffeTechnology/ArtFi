import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RwaSourceRecord } from "./rwa-source-record";
import { rwaCatalogFixture } from "../test/rwa-catalog-fixture";
const record = () => {
  const a = rwaCatalogFixture();
  Object.assign(a, {
    title: "TEST_ONLY_PRIVATE_TITLE",
    artist: "TEST_ONLY_PRIVATE_ARTIST",
    medium: "TEST_ONLY_PRIVATE_MEDIUM",
    location: "TEST_ONLY_PRIVATE_LOCATION",
    description: "TEST_ONLY_PRIVATE_DESCRIPTION",
    rights: "TEST_ONLY_PRIVATE_RIGHTS",
    provenance: ["TEST_ONLY_PRIVATE_PROVENANCE"],
    revision: 734911,
  });
  Object.assign(a.grounding, {
    sourceName: "TEST_ONLY_PRIVATE_SOURCE_NAME",
    sourceId: "TEST_ONLY_PRIVATE_SOURCE_ID",
  });
  return a;
};
const render = (a = record()) =>
  renderToStaticMarkup(createElement(RwaSourceRecord, { asset: a }));
const translatable = (html: string) =>
  html
    .replace(
      /<(h1|p|dd|li|span)\b[^>]*data-no-translate[^>]*>[\s\S]*?<\/\1>/g,
      "",
    )
    .replace(/<[^>]+>/g, " ");
describe("RWA source record exact facts and translatable fixed UI", () => {
  it("excludes original source-authored names, text and rights from translation selection", () => {
    const a = record(),
      html = render(a),
      text = translatable(html);
    for (const value of [
      a.title,
      a.artist,
      a.medium,
      a.location,
      a.description,
      a.rights,
      ...a.provenance,
      a.grounding.sourceName,
      a.grounding.sourceId,
    ]) {
      expect(html).toContain(value);
      expect(text).not.toContain(value);
    }
  });
  it("excludes exact source identity, timing, status, revision, digest and token facts", () => {
    const a = record(),
      html = render(a),
      text = translatable(html);
    for (const value of [
      a.grounding.sourceKind,
      a.grounding.status,
      a.grounding.sourceReference,
      a.grounding.evidenceSha256,
      a.grounding.validFrom,
      a.grounding.validUntil,
      a.grounding.verifiedAt,
      a.updatedAt,
      String(a.revision),
      a.binding.collectionAddress,
    ]) {
      expect(html).toContain(value);
      expect(text).not.toContain(value);
    }
  });
  it("keeps original fixed labels and disclosures available to the approved translator", () => {
    const html = render(),
      text = translatable(html);
    expect(html.match(/<section[^>]*>/)?.[0]).not.toContain(
      "data-no-translate",
    );
    for (const label of [
      "Source correspondence evidence",
      "Evidence status:",
      "Evidence source",
      "Source reference",
      "Evidence digest",
      "Signed validity window",
      "Last verification",
      "Bound token",
      "Rights stated by the source",
      "Attributed evidence references",
      "Catalog revision",
    ])
      expect(text).toContain(label);
  });
  it("keeps isolated no-real-value and no-legal-effect disclosure explicit", () => {
    expect(render()).toContain(
      "TESTNET / NO REAL-WORLD VALUE / NO LEGAL EFFECT",
    );
    expect(translatable(render())).toContain(
      "does not authenticate a real asset or authorize real-value activity",
    );
  });
  it.each([true, false])(
    "preserves the source-authenticated registry distinction %s",
    (registryBacked) => {
      const a = record();
      a.grounding.registryBacked = registryBacked;
      const text = translatable(render(a));
      expect(text).toContain(
        registryBacked
          ? "Token transfer alone is not registry transfer."
          : "not represented as a registry ownership record.",
      );
      expect(text).toContain(
        "Token possession alone does not establish physical title",
      );
    },
  );
  it.each(["whole", "fractional"] as const)(
    "retains product section meaning for %s",
    (section) => {
      const a = record();
      a.section = section;
      expect(translatable(render(a))).toContain(
        section === "whole"
          ? "Whole-artwork receipt / voucher"
          : "Fractional participation / underlying RWA",
      );
    },
  );
  it("retains unavailable-source exit guidance without creating a new execution gate", () => {
    const a = record();
    a.grounding.status = "source-unavailable";
    const text = translatable(render(a));
    expect(text).toContain("Owner revocation and existing settlement");
    expect(text).toContain("withdrawal exits are not frozen");
  });
  it("escapes source-authored markup as text while keeping it outside translation", () => {
    const a = record();
    a.title = "<script>TEST_ONLY_PRIVATE_SCRIPT</script>";
    a.rights = "<img src=x onerror=alert(1)>";
    a.provenance = [
      '<a href="https://fixture.invalid/private">TEST_ONLY_PRIVATE_LINK</a>',
    ];
    const html = render(a);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a href=");
    expect(html).toContain("&lt;script&gt;");
    expect(translatable(html)).not.toContain("TEST_ONLY_PRIVATE_SCRIPT");
    expect(translatable(html)).not.toContain("TEST_ONLY_PRIVATE_LINK");
  });
});
