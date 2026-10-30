import { describe, expect, it } from "vitest";

import {
  accessibleLanguageNameFor,
  htmlLangFor,
  isTranslatableSource,
  isSafeUiTranslation,
  maxUiTranslationBytes,
  isUiLocale,
  needsTranslation,
  protectedTermsIntact,
  proofreaderWarningsAreSafe,
  sourceLanguageFor,
  translationSourceFor,
  translationTargetFor,
  uiLocaleOptions,
} from "./language";

describe("ArtFi language contract", () => {
  it("exposes the approved compact eight-language order", () => {
    expect(uiLocaleOptions.map(({ label, locale }) => [locale, label])).toEqual(
      [
        ["en", "EN"],
        ["zh", "简"],
        ["zht", "繁"],
        ["fr", "FR"],
        ["es", "ES"],
        ["de", "DE"],
        ["ko", "한"],
        ["ja", "日"],
      ],
    );
    expect(htmlLangFor("zh")).toBe("zh-CN");
    expect(htmlLangFor("zht")).toBe("zh-Hant");
    expect(translationTargetFor("zht")).toBe("zh-Hant");
    expect(accessibleLanguageNameFor("ko")).toBe("한국어");
  });

  it("rejects unknown locales and non-copy values", () => {
    expect(isUiLocale("ja")).toBe(true);
    expect(isUiLocale("fr")).toBe(true);
    expect(isUiLocale("zh-Hant")).toBe(false);
    expect(isTranslatableSource("Live market signals.")).toBe(true);
    expect(
      isTranslatableSource("0xFa67da006Fc31b00e3a8ED94098230F895b0FAd8"),
    ).toBe(false);
    expect(isTranslatableSource("https://opensea.io/assets/example")).toBe(
      false,
    );
    expect(isTranslatableSource("连接外部钱包。 ")).toBe(true);
    expect(isTranslatableSource("ウォレットを接続します。 ")).toBe(true);
  });

  it("detects source copy and translates only when needed", () => {
    expect(sourceLanguageFor("Live market signals.")).toBe("en");
    expect(sourceLanguageFor("连接外部钱包。")).toBe("zh");
    expect(sourceLanguageFor("ウォレットを接続します。")).toBe("ja");
    expect(needsTranslation("Live market signals.", "en")).toBe(false);
    expect(needsTranslation("连接外部钱包。", "en")).toBe(true);
    expect(needsTranslation("连接外部钱包。", "zht")).toBe(true);
    expect(needsTranslation("ウォレットを接続します。", "ja")).toBe(false);
    expect(translationSourceFor("Live market signals.", "fr")).toBe("en");
    expect(translationSourceFor("连接外部钱包。", "fr")).toBeNull();
  });

  it("fails closed when protected brand and protocol terms are damaged", () => {
    const source = "ArtCCH:ArtFi mirrors OpenSea on Ethereum.";
    expect(
      protectedTermsIntact(source, "ArtCCH:ArtFi 镜像 OpenSea 于 Ethereum。"),
    ).toBe(true);
    expect(protectedTermsIntact(source, "某品牌镜像某市场。")).toBe(false);
  });

  it("accepts only typed proofreader degradation after primary translation", () => {
    const proofreader = { role: "proofread-only", status: "rejected" };
    expect(
      proofreaderWarningsAreSafe(proofreader, [{ code: "PROOFREAD_REJECTED" }]),
    ).toBe(true);
    expect(
      proofreaderWarningsAreSafe(proofreader, [{ code: "TRANSLATION_FAILED" }]),
    ).toBe(false);
    expect(
      proofreaderWarningsAreSafe({ role: "translator", status: "rejected" }, [
        { code: "PROOFREAD_REJECTED" },
      ]),
    ).toBe(false);
  });
});

describe("authoritative translation literals", () => {
  it.each([
    "Seller: 0xFa67da006Fc31b00e3a8ED94098230F895b0FAd8",
    `Transaction: 0x${"a".repeat(64)}`,
    "Evidence: https://example.invalid/record/123",
    "Contact: owner@example.invalid",
    "Help: mailto:owner@example.invalid",
  ])("does not submit embedded technical identities: %s", (text) => {
    expect(isTranslatableSource(text)).toBe(false);
  });
  it.each([
    ["Buy 10 fractions for 0.01 ETH", "Acheter 10 fractions pour 0.01 ETH"],
    [
      "Maximum 100 USDC for 2 fractions",
      "2 fractions pour un maximum de 100 USDC",
    ],
    ["10 units and 10 units", "10 unités et 10 unités"],
    ["No claim is available", "청구할 수 없습니다"],
  ])(
    "retains exact literal facts while allowing translated grammar",
    (source, candidate) => {
      expect(isSafeUiTranslation(source, candidate)).toBe(true);
    },
  );
  it.each([
    ["Pay 0.01 ETH", "Payer 0.1 ETH"],
    ["Pay 0.010 ETH", "Payer 0.01 ETH"],
    ["Pay 100 USDC", "Payer 100 USDT"],
    ["Pay 100USDC", "Payer 100USDT"],
    ["Cost 100gwei", "Coût 100wei"],
    ["Pay 100 USDC", "Payer 100"],
    ["10 units and 10 units", "10 unités"],
    ["No claim is available", "1 réclamation disponible"],
    ["Change -5 USD", "Variation 5 USD"],
    ["Threshold 80%", "Seuil 8%"],
    ["OpenSea order", "Autre marché"],
    ["Review current order", "Voir https://example.invalid/order"],
  ])("refuses added, altered or lost facts", (source, candidate) => {
    expect(isSafeUiTranslation(source, candidate)).toBe(false);
  });
  it("bounds actual UTF-8 bytes and rejects empty or nonstring cache entries", () => {
    expect(isSafeUiTranslation("English source", "界".repeat(3000))).toBe(
      false,
    );
    expect(
      isSafeUiTranslation(
        "English source",
        "x".repeat(maxUiTranslationBytes + 1),
      ),
    ).toBe(false);
    expect(isSafeUiTranslation("English source", " ")).toBe(false);
    expect(isSafeUiTranslation("English source", undefined)).toBe(false);
  });
});
