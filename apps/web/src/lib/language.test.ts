import { describe, expect, it } from "vitest";

import {
  htmlLangFor,
  isTranslatableSource,
  isUiLocale,
  protectedTermsIntact,
  uiLocaleOptions,
} from "./language";

describe("ArtFi language contract", () => {
  it("exposes the approved four-language order", () => {
    expect(uiLocaleOptions.map(({ label, locale }) => [locale, label])).toEqual(
      [
        ["en", "EN"],
        ["zh", "简"],
        ["zh-Hant", "繁"],
        ["ja", "日"],
      ],
    );
    expect(htmlLangFor("zh")).toBe("zh-Hans");
    expect(htmlLangFor("zh-Hant")).toBe("zh-Hant");
  });

  it("rejects unknown locales and non-copy values", () => {
    expect(isUiLocale("ja")).toBe(true);
    expect(isUiLocale("fr")).toBe(false);
    expect(isTranslatableSource("Live market signals.")).toBe(true);
    expect(
      isTranslatableSource("0xFa67da006Fc31b00e3a8ED94098230F895b0FAd8"),
    ).toBe(false);
    expect(isTranslatableSource("https://opensea.io/assets/example")).toBe(
      false,
    );
  });

  it("fails closed when protected brand and protocol terms are damaged", () => {
    const source = "ArtCCH:ArtFi mirrors OpenSea on Ethereum.";
    expect(
      protectedTermsIntact(source, "ArtCCH:ArtFi 镜像 OpenSea 于 Ethereum。"),
    ).toBe(true);
    expect(protectedTermsIntact(source, "某品牌镜像某市场。")).toBe(false);
  });
});
