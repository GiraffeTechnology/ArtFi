"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  htmlLangFor,
  isTranslatableSource,
  isUiLocale,
  needsTranslation,
  translationSourceFor,
  type UiLocale,
} from "@/lib/language";

type TranslationStatus = "idle" | "loading" | "ready" | "unavailable";
type LanguageContextValue = {
  locale: UiLocale;
  setLocale: (locale: UiLocale) => void;
  status: TranslationStatus;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);
const languageStorageKey = "artfi-ui-language";
// The translation pipeline may serialize primary translation and proofreading.
// Keep each page request bounded, then render the page progressively.
const translationRequestBatchSize = 4;
const originals = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const originalPageTitles = new Map<string, string>();
const translatedCache = new Map<string, string>();
const translatableAttributes = [
  "aria-label",
  "alt",
  "placeholder",
  "title",
] as const;

function translationCacheKey(locale: UiLocale, source: string): string {
  return `artfi-translation:${locale}:${source}`;
}

function cachedTranslation(locale: UiLocale, source: string): string | null {
  const memoryKey = `${locale}\u0000${source}`;
  const inMemory = translatedCache.get(memoryKey);
  if (inMemory) return inMemory;
  try {
    const persisted = window.sessionStorage.getItem(
      translationCacheKey(locale, source),
    );
    if (persisted) {
      translatedCache.set(memoryKey, persisted);
      return persisted;
    }
  } catch {
    // Session caching is optional.
  }
  return null;
}

function cacheTranslation(
  locale: UiLocale,
  source: string,
  translated: string,
): void {
  translatedCache.set(`${locale}\u0000${source}`, translated);
  try {
    window.sessionStorage.setItem(
      translationCacheKey(locale, source),
      translated,
    );
  } catch {
    // Session caching is optional.
  }
}

type AttributeBinding = {
  element: Element;
  name: (typeof translatableAttributes)[number] | "content";
  original: string;
};

function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node as Text;
      const parent = text.parentElement;
      if (
        !parent ||
        parent.closest(
          "[data-no-translate], [data-translation-skip], select, option, script, style, noscript, code, pre, svg, canvas, textarea, input",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      const source = originals.get(text) ?? text.data;
      if (!isTranslatableSource(source)) return NodeFilter.FILTER_REJECT;
      if (!originals.has(text)) originals.set(text, source);
      nodes.push(text);
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) {
    // Text nodes are collected inside acceptNode.
  }
  return nodes;
}

function renderTranslatedText(original: string, translated: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? "";
  const trailing = original.match(/\s*$/)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

function collectAttributeBindings(root: HTMLElement): AttributeBinding[] {
  const bindings: AttributeBinding[] = [];
  const elements = [root, ...root.querySelectorAll("*")];
  for (const element of elements) {
    if (
      element.closest(
        "[data-no-translate], [data-translation-skip], select, option",
      )
    )
      continue;
    for (const name of translatableAttributes) {
      const current = element.getAttribute(name);
      if (!current) continue;
      const originalsForElement =
        originalAttributes.get(element) ?? new Map<string, string>();
      if (!originalAttributes.has(element)) {
        originalAttributes.set(element, originalsForElement);
      }
      const original = originalsForElement.get(name) ?? current;
      if (!originalsForElement.has(name))
        originalsForElement.set(name, original);
      if (isTranslatableSource(original)) {
        bindings.push({ element, name, original });
      }
    }
  }

  const description = document.querySelector('meta[name="description"]');
  const currentDescription = description?.getAttribute("content");
  if (description && currentDescription) {
    const originalsForElement =
      originalAttributes.get(description) ?? new Map<string, string>();
    if (!originalAttributes.has(description)) {
      originalAttributes.set(description, originalsForElement);
    }
    const original = originalsForElement.get("content") ?? currentDescription;
    if (!originalsForElement.has("content")) {
      originalsForElement.set("content", original);
    }
    if (isTranslatableSource(original)) {
      bindings.push({ element: description, name: "content", original });
    }
  }
  return bindings;
}

function restoreOriginals(root: HTMLElement, pathname: string) {
  for (const node of collectTextNodes(root)) {
    const original = originals.get(node);
    if (original !== undefined && node.data !== original) node.data = original;
  }
  for (const binding of collectAttributeBindings(root)) {
    if (binding.element.getAttribute(binding.name) !== binding.original) {
      binding.element.setAttribute(binding.name, binding.original);
    }
  }
  const originalTitle = originalPageTitles.get(pathname) ?? document.title;
  if (!originalPageTitles.has(pathname)) {
    originalPageTitles.set(pathname, originalTitle);
  }
  document.title = originalTitle;
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [locale, updateLocale] = useState<UiLocale>("en");
  const [status, setStatus] = useState<TranslationStatus>("idle");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(languageStorageKey);
      if (saved === "zh-Hant") {
        window.localStorage.setItem(languageStorageKey, "zht");
        const timer = window.setTimeout(() => updateLocale("zht"), 0);
        return () => window.clearTimeout(timer);
      }
      if (isUiLocale(saved)) {
        const timer = window.setTimeout(() => updateLocale(saved), 0);
        return () => window.clearTimeout(timer);
      }
    } catch {
      // Persistence is optional; the current session remains functional.
    }
  }, []);

  const setLocale = useCallback((nextLocale: UiLocale) => {
    updateLocale(nextLocale);
    try {
      window.localStorage.setItem(languageStorageKey, nextLocale);
    } catch {
      // Persistence is optional; the current session remains functional.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = htmlLangFor(locale);
    const root = document.body;
    restoreOriginals(root, pathname);

    const controller = new AbortController();
    let disposed = false;
    let timer: number | undefined;
    let translating = false;

    async function translateVisiblePage() {
      if (disposed || translating) return;
      translating = true;
      setStatus("loading");
      root.setAttribute("aria-busy", "true");
      try {
        const nodes = collectTextNodes(root);
        const attributes = collectAttributeBindings(root);
        const pageTitle = originalPageTitles.get(pathname) ?? document.title;
        const sources = [
          ...new Set([
            ...nodes.map((node) => originals.get(node)!.trim()),
            ...attributes.map((binding) => binding.original.trim()),
            pageTitle.trim(),
          ]),
        ].filter(
          (source) =>
            needsTranslation(source, locale) &&
            translationSourceFor(source, locale) !== null,
        );
        if (sources.length === 0) {
          if (!disposed) setStatus("idle");
          return;
        }
        let degraded = false;

        for (
          let offset = 0;
          offset < sources.length;
          offset += translationRequestBatchSize
        ) {
          const chunk = sources.slice(
            offset,
            offset + translationRequestBatchSize,
          );
          const missing = chunk.filter(
            (source) => !cachedTranslation(locale, source),
          );
          if (missing.length > 0) {
            const response = await fetch("/api/language/v1/translate-page", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ target_language: locale, texts: missing }),
              cache: "no-store",
              signal: controller.signal,
            });
            if (!response.ok) throw new Error("TRANSLATION_UNAVAILABLE");
            const payload = (await response.json()) as {
              degraded?: unknown;
              translations?: unknown;
            };
            if (
              !Array.isArray(payload.translations) ||
              payload.translations.length !== missing.length ||
              payload.translations.some((value) => typeof value !== "string")
            ) {
              throw new Error("INVALID_TRANSLATION_RESPONSE");
            }
            degraded ||= payload.degraded === true;
            const translations = payload.translations as string[];
            missing.forEach((source, index) => {
              const translated = translations[index];
              if (translated.trim() && translated.trim() !== source) {
                cacheTranslation(locale, source, translated.trim());
              }
            });
          }

          for (const node of nodes) {
            const original = originals.get(node);
            if (!original) continue;
            const translated = cachedTranslation(locale, original.trim());
            if (translated) {
              const nextValue = renderTranslatedText(original, translated);
              if (node.data !== nextValue) node.data = nextValue;
            }
          }
          for (const binding of attributes) {
            const translated = cachedTranslation(
              locale,
              binding.original.trim(),
            );
            if (translated)
              binding.element.setAttribute(binding.name, translated);
          }
          const translatedTitle = cachedTranslation(locale, pageTitle.trim());
          if (translatedTitle) document.title = translatedTitle;
        }
        if (!disposed) setStatus(degraded ? "unavailable" : "ready");
      } catch (error) {
        if (
          !disposed &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          restoreOriginals(root, pathname);
          setStatus("unavailable");
        }
      } finally {
        translating = false;
        if (!disposed) root.removeAttribute("aria-busy");
      }
    }

    const observer = new MutationObserver((mutations) => {
      if (
        !mutations.some(
          (mutation) =>
            mutation.type === "characterData" || mutation.addedNodes.length > 0,
        )
      )
        return;
      window.clearTimeout(timer);
      timer = window.setTimeout(translateVisiblePage, 80);
    });
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    void translateVisiblePage();

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [locale, pathname]);

  const value = useMemo(
    () => ({ locale, setLocale, status }),
    [locale, setLocale, status],
  );

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("LANGUAGE_PROVIDER_REQUIRED");
  return context;
}
