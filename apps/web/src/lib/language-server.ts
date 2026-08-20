import "server-only";

import {
  isTranslatableSource,
  protectedTermsIntact,
  type UiLocale,
} from "./language";

type UpstreamTranslation = {
  model?: unknown;
  provider?: unknown;
  translated_text?: unknown;
  warnings?: unknown;
};

type TranslationCache = Map<string, string>;

const runtime = globalThis as typeof globalThis & {
  __artfiTranslationCache?: TranslationCache;
};
const cache = runtime.__artfiTranslationCache ?? new Map<string, string>();
runtime.__artfiTranslationCache = cache;

const MAX_CACHE_ENTRIES = 1_200;

function languageEndpoint(path: string): string {
  const base = process.env.GIRAFFE_LANGUAGE_URL?.trim();
  if (!base) {
    throw new Error("TRANSLATION_NOT_CONFIGURED");
  }
  const prefix = process.env.GIRAFFE_LANGUAGE_API_PREFIX?.trim() ?? "";
  const normalizedPrefix = prefix ? `/${prefix.replace(/^\/+|\/+$/g, "")}` : "";
  return `${base.replace(/\/+$/, "")}${normalizedPrefix}${path}`;
}

function translationTimeoutMs(): number {
  const configured = Number(process.env.TRANSLATION_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.min(configured, 60_000)
    : 15_000;
}

function cacheTranslation(key: string, value: string): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest === "string") cache.delete(oldest);
  }
  cache.set(key, value);
}

async function translateText(sourceText: string, targetLanguage: UiLocale) {
  if (!isTranslatableSource(sourceText)) return sourceText;
  const key = `${targetLanguage}\u0000${sourceText}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), translationTimeoutMs());
  try {
    const response = await fetch(languageEndpoint("/v1/translate"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source_text: sourceText,
        source_language: "en",
        target_language: targetLanguage,
        domain_hint:
          "ArtCCH ArtFi digital art, NFT, Ethereum, DAO, wallet and external marketplace mirror",
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("TRANSLATION_UPSTREAM_FAILED");

    const body = (await response.json()) as UpstreamTranslation;
    const translated = body.translated_text;
    if (
      typeof translated !== "string" ||
      !translated.trim() ||
      translated.trim() === sourceText.trim() ||
      typeof body.provider !== "string" ||
      !body.provider.trim() ||
      typeof body.model !== "string" ||
      !body.model.trim() ||
      !Array.isArray(body.warnings) ||
      body.warnings.length > 0 ||
      !protectedTermsIntact(sourceText, translated)
    ) {
      throw new Error("INVALID_TRANSLATION_RESPONSE");
    }
    cacheTranslation(key, translated.trim());
    return translated.trim();
  } finally {
    clearTimeout(timer);
  }
}

export async function translatePageTexts(
  texts: ReadonlyArray<string>,
  targetLanguage: Exclude<UiLocale, "en">,
): Promise<{ degraded: boolean; translations: string[] }> {
  const translations = [...texts];
  let degraded = false;
  let cursor = 0;

  async function worker() {
    while (cursor < texts.length) {
      const index = cursor++;
      try {
        translations[index] = await translateText(texts[index], targetLanguage);
      } catch {
        degraded = true;
        translations[index] = texts[index];
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, texts.length) }, worker));
  return { degraded, translations };
}
