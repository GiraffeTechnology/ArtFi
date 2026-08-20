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
const originals = new WeakMap<Text, string>();
const translatedCache = new Map<string, string>();

function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node as Text;
      const parent = text.parentElement;
      if (
        !parent ||
        parent.closest(
          "[data-no-translate], script, style, noscript, code, pre, svg, canvas, textarea, input",
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

function restoreOriginals(root: HTMLElement) {
  for (const node of collectTextNodes(root)) {
    const original = originals.get(node);
    if (original !== undefined && node.data !== original) node.data = original;
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [locale, updateLocale] = useState<UiLocale>("en");
  const [status, setStatus] = useState<TranslationStatus>("idle");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(languageStorageKey);
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
    restoreOriginals(root);

    const controller = new AbortController();
    let disposed = false;
    let timer: number | undefined;
    let translating = false;

    async function translateVisiblePage() {
      if (disposed || translating) return;
      translating = true;
      setStatus("loading");
      try {
        const nodes = collectTextNodes(root);
        const sources = [
          ...new Set(nodes.map((node) => originals.get(node)!.trim())),
        ].filter((source) => needsTranslation(source, locale));
        if (sources.length === 0) {
          if (!disposed) setStatus("idle");
          return;
        }
        let degraded = false;

        for (let offset = 0; offset < sources.length; offset += 32) {
          const chunk = sources.slice(offset, offset + 32);
          const missing = chunk.filter(
            (source) => !translatedCache.has(`${locale}\u0000${source}`),
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
                translatedCache.set(
                  `${locale}\u0000${source}`,
                  translated.trim(),
                );
              }
            });
          }

          for (const node of nodes) {
            const original = originals.get(node);
            if (!original) continue;
            const translated = translatedCache.get(
              `${locale}\u0000${original.trim()}`,
            );
            if (translated)
              node.data = renderTranslatedText(original, translated);
          }
        }
        if (!disposed) setStatus(degraded ? "unavailable" : "ready");
      } catch (error) {
        if (
          !disposed &&
          !(error instanceof DOMException && error.name === "AbortError")
        ) {
          restoreOriginals(root);
          setStatus("unavailable");
        }
      } finally {
        translating = false;
      }
    }

    const observer = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => mutation.addedNodes.length > 0)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(translateVisiblePage, 80);
    });
    observer.observe(root, { childList: true, subtree: true });
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
