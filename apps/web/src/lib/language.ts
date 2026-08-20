export const uiLocales = ["en", "zh", "zh-Hant", "ja"] as const;

export type UiLocale = (typeof uiLocales)[number];

export const uiLocaleOptions: ReadonlyArray<{
  label: string;
  locale: UiLocale;
  htmlLang: string;
}> = [
  { label: "EN", locale: "en", htmlLang: "en" },
  { label: "简", locale: "zh", htmlLang: "zh-Hans" },
  { label: "繁", locale: "zh-Hant", htmlLang: "zh-Hant" },
  { label: "日", locale: "ja", htmlLang: "ja" },
];

export const protectedTranslationTerms = [
  "ArtCCH",
  "ArtFi",
  "OpenSea",
  "CCHS",
  "Giraffe ArtFi Corp.",
  "Ethereum",
  "Sepolia",
  "ERC-1155",
  "NFT",
  "DAO",
  "ETH",
] as const;

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && uiLocales.includes(value as UiLocale);
}

export function htmlLangFor(locale: UiLocale): string {
  return (
    uiLocaleOptions.find((option) => option.locale === locale)?.htmlLang ?? "en"
  );
}

export function isTranslatableSource(value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text.length > 600 || !/[A-Za-z]/.test(text)) {
    return false;
  }
  if (
    /^(?:https?:\/\/|mailto:|0x[0-9a-f]{8,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(
      text,
    )
  ) {
    return false;
  }
  return true;
}

export function protectedTermsIntact(
  source: string,
  candidate: string,
): boolean {
  return protectedTranslationTerms.every(
    (term) => !source.includes(term) || candidate.includes(term),
  );
}
