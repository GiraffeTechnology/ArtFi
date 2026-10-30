export const uiLocales = [
  "en",
  "zh",
  "zht",
  "fr",
  "es",
  "de",
  "ko",
  "ja",
] as const;

export type UiLocale = (typeof uiLocales)[number];
export type SourceLanguage = "en" | "zh" | "ja";
export type TranslationTarget =
  "en" | "zh" | "zh-Hant" | "fr" | "es" | "de" | "ko" | "ja";

export const uiLocaleOptions: ReadonlyArray<{
  accessibleName: string;
  label: string;
  locale: UiLocale;
  htmlLang: string;
  translationTarget: TranslationTarget;
}> = [
  {
    accessibleName: "English",
    label: "EN",
    locale: "en",
    htmlLang: "en",
    translationTarget: "en",
  },
  {
    accessibleName: "简体中文",
    label: "简",
    locale: "zh",
    htmlLang: "zh-CN",
    translationTarget: "zh",
  },
  {
    accessibleName: "繁體中文",
    label: "繁",
    locale: "zht",
    htmlLang: "zh-Hant",
    translationTarget: "zh-Hant",
  },
  {
    accessibleName: "Français",
    label: "FR",
    locale: "fr",
    htmlLang: "fr",
    translationTarget: "fr",
  },
  {
    accessibleName: "Español",
    label: "ES",
    locale: "es",
    htmlLang: "es",
    translationTarget: "es",
  },
  {
    accessibleName: "Deutsch",
    label: "DE",
    locale: "de",
    htmlLang: "de",
    translationTarget: "de",
  },
  {
    accessibleName: "한국어",
    label: "한",
    locale: "ko",
    htmlLang: "ko",
    translationTarget: "ko",
  },
  {
    accessibleName: "日本語",
    label: "日",
    locale: "ja",
    htmlLang: "ja",
    translationTarget: "ja",
  },
];

const englishAuthoritativeTargets = new Set<UiLocale>([
  "fr",
  "es",
  "de",
  "ko",
  "ja",
]);

export const protectedTranslationTerms = [
  "ArtCCH",
  "ArtFi",
  "OpenSea",
  "CCHS",
  "Giraffe ArtFi Corp.",
  "Ethereum",
  "Hoodi",
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

export function translationTargetFor(locale: UiLocale): TranslationTarget {
  return (
    uiLocaleOptions.find((option) => option.locale === locale)
      ?.translationTarget ?? "en"
  );
}

export function accessibleLanguageNameFor(locale: UiLocale): string {
  return (
    uiLocaleOptions.find((option) => option.locale === locale)
      ?.accessibleName ?? "English"
  );
}

// Technical identities are authoritative data, including when embedded in labels.
// Keep them out of the translation request rather than asking a model to copy them.
const translationIdentity =
  /https?:\/\/|mailto:|0x[0-9a-f]{8,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i;
export const maxUiTranslationBytes = 8 * 1024;

export function isTranslatableSource(value: string): boolean {
  const text = value.trim();
  if (
    text.length < 2 ||
    text.length > 600 ||
    !/[A-Za-z\u3400-\u9fff\u3040-\u30ff]/.test(text)
  ) {
    return false;
  }
  if (translationIdentity.test(text)) return false;
  return true;
}

export function sourceLanguageFor(value: string): SourceLanguage {
  if (/[\u3040-\u30ff]/.test(value)) return "ja";
  if (/[\u3400-\u9fff]/.test(value)) return "zh";
  return "en";
}

export function needsTranslation(value: string, target: UiLocale): boolean {
  const source = sourceLanguageFor(value);
  if (target === "zht") return true;
  return source !== target;
}

export function translationSourceFor(
  value: string,
  target: UiLocale,
): SourceLanguage | null {
  const detected = sourceLanguageFor(value);
  if (englishAuthoritativeTargets.has(target)) {
    return detected === "en" ? "en" : null;
  }
  return detected;
}

export function proofreaderWarningsAreSafe(
  proofreader: unknown,
  warnings: ReadonlyArray<unknown>,
): boolean {
  if (warnings.length === 0) return true;
  if (!proofreader || typeof proofreader !== "object") return false;
  const metadata = proofreader as { role?: unknown; status?: unknown };
  if (
    metadata.role !== "proofread-only" ||
    !["unavailable", "rejected"].includes(String(metadata.status))
  ) {
    return false;
  }
  return warnings.every((warning) => {
    if (!warning || typeof warning !== "object") return false;
    const code = (warning as { code?: unknown }).code;
    return code === "PROOFREAD_FAILED" || code === "PROOFREAD_REJECTED";
  });
}

export function protectedTermsIntact(
  source: string,
  candidate: string,
): boolean {
  return protectedTranslationTerms.every(
    (term) => !source.includes(term) || candidate.includes(term),
  );
}

// Literal facts may be reordered by grammar, but cannot be changed, added or lost.
// This is a display-integrity guard, never validation of financial authority or meaning.
function translationFacts(value: string): string[] {
  const numbers =
    value.match(/[+-]?[0-9]+(?:[.,][0-9]+)*(?:[eE][+-]?[0-9]+)?%?/g) ?? [];
  const units =
    value.match(
      /(?<![A-Za-z])(?:ETH|WETH|USDC|USDT|DAI|wei|gwei|USD|EUR|CAD)(?![A-Za-z])/g,
    ) ?? [];
  return [
    ...numbers.map((n) => `number:${n}`),
    ...units.map((u) => `unit:${u}`),
  ].sort();
}

export function isSafeUiTranslation(
  source: string,
  candidate: unknown,
): candidate is string {
  if (
    typeof candidate !== "string" ||
    !candidate.trim() ||
    candidate.length > maxUiTranslationBytes ||
    new TextEncoder().encode(candidate).byteLength > maxUiTranslationBytes ||
    translationIdentity.test(candidate) ||
    !protectedTermsIntact(source, candidate)
  )
    return false;
  const expected = translationFacts(source),
    actual = translationFacts(candidate);
  return (
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
  );
}
