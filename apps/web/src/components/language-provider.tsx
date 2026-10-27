"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  htmlLangFor,
  isTranslatableSource,
  isSafeUiTranslation,
  isUiLocale,
  needsTranslation,
  translationSourceFor,
  type UiLocale,
} from "@/lib/language";
import {
  StaticSelectLabels,
  staticSelectMutationAttributes,
} from "@/lib/static-select-labels";

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
type SourceBinding = { original: string; rendered: string };
const originals = new WeakMap<Text, SourceBinding>();
const originalAttributes = new WeakMap<Element, Map<string, SourceBinding>>();
let pageTitleBinding: SourceBinding | undefined;
const writtenTexts = new WeakMap<Text, string>();
const writtenAttributes = new WeakMap<Element, Map<string, string>>();
let writtenTitle: string | undefined;
const translatedCache = new Map<string, string>();
const staticOptionLabels = new StaticSelectLabels();
const translatableAttributes = [
  "aria-label",
  "alt",
  "placeholder",
  "title",
] as const;

// React may reuse a node for a new authoritative value. Only a value that this
// component actually rendered is a translation of the previously captured source.
function captureSource(previous: SourceBinding | undefined, current: string) {
  return previous &&
    (current === previous.original || current === previous.rendered)
    ? previous
    : { original: current, rendered: current };
}

function textSource(node: Text): string {
  const binding = captureSource(originals.get(node), node.data);
  originals.set(node, binding);
  return binding.original;
}

function writeText(node: Text, source: string, rendered: string) {
  if (
    !node.isConnected ||
    !node.parentElement ||
    node.parentElement.closest(
      "[data-no-translate], [data-translation-skip], select, option, script, style, noscript, code, pre, svg, canvas, textarea, input",
    ) ||
    textSource(node) !== source
  )
    return;
  originals.get(node)!.rendered = rendered;
  if (node.data !== rendered) {
    writtenTexts.set(node, rendered);
    node.data = rendered;
  }
}

function attributeSource(element: Element, name: string, current: string) {
  const bindings =
    originalAttributes.get(element) ?? new Map<string, SourceBinding>();
  originalAttributes.set(element, bindings);
  const binding = captureSource(bindings.get(name), current);
  bindings.set(name, binding);
  return binding.original;
}

function writeAttribute(binding: AttributeBinding, rendered: string) {
  const { element, name, original } = binding;
  const current = element.getAttribute(name);
  if (
    !element.isConnected ||
    current === null ||
    element.closest(
      "[data-no-translate], [data-translation-skip], select, option",
    ) ||
    attributeSource(element, name, current) !== original
  )
    return;
  originalAttributes.get(element)!.get(name)!.rendered = rendered;
  if (current !== rendered) {
    const values = writtenAttributes.get(element) ?? new Map<string, string>();
    writtenAttributes.set(element, values);
    values.set(name, rendered);
    element.setAttribute(name, rendered);
  }
}

function titleSource() {
  pageTitleBinding = captureSource(pageTitleBinding, document.title);
  return pageTitleBinding.original;
}

function writeTitle(source: string, rendered: string) {
  if (titleSource() !== source) return;
  pageTitleBinding!.rendered = rendered;
  if (document.title !== rendered) {
    writtenTitle = rendered;
    document.title = rendered;
  }
}

function needsSourceScan(mutation: MutationRecord) {
  if (
    mutation.type === "attributes" &&
    staticSelectMutationAttributes.some(
      (name) => name === mutation.attributeName,
    )
  ) {
    return staticOptionLabels.needsSourceScan(mutation);
  }
  if (staticOptionLabels.needsSourceScan(mutation)) return true;
  const element =
    mutation.target instanceof Element
      ? mutation.target
      : mutation.target.parentElement;
  const skipped =
    mutation.type === "attributes"
      ? "[data-no-translate], [data-translation-skip], select, option"
      : "[data-no-translate], [data-translation-skip], select, option, script, style, noscript, code, pre, svg, canvas, textarea, input";
  if (element?.closest(skipped)) return false;
  if (element?.tagName === "TITLE" && document.title === writtenTitle)
    return false;
  if (mutation.type === "characterData") {
    return (
      mutation.target.nodeValue !== writtenTexts.get(mutation.target as Text)
    );
  }
  if (mutation.type === "attributes" && element && mutation.attributeName) {
    return (
      element.getAttribute(mutation.attributeName) !==
      writtenAttributes.get(element)?.get(mutation.attributeName)
    );
  }
  return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
}

function translationCacheKey(locale: UiLocale, source: string): string {
  return `artfi-translation:${locale}:${source}`;
}

function cachedTranslation(locale: UiLocale, source: string): string | null {
  const memoryKey = `${locale}\u0000${source}`;
  const inMemory = translatedCache.get(memoryKey);
  if (inMemory && isSafeUiTranslation(source, inMemory)) return inMemory;
  if (inMemory) translatedCache.delete(memoryKey);
  try {
    const persisted = window.sessionStorage.getItem(
      translationCacheKey(locale, source),
    );
    if (persisted && isSafeUiTranslation(source, persisted)) {
      translatedCache.set(memoryKey, persisted);
      return persisted;
    }
    if (persisted)
      window.sessionStorage.removeItem(translationCacheKey(locale, source));
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
  if (!isSafeUiTranslation(source, translated)) return;
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
      const source = textSource(text);
      if (!isTranslatableSource(source)) return NodeFilter.FILTER_REJECT;
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
      const original = attributeSource(element, name, current);
      if (isTranslatableSource(original)) {
        bindings.push({ element, name, original });
      }
    }
  }

  const description = document.querySelector('meta[name="description"]');
  const currentDescription = description?.getAttribute("content");
  if (description && currentDescription) {
    const original = attributeSource(
      description,
      "content",
      currentDescription,
    );
    if (isTranslatableSource(original)) {
      bindings.push({ element: description, name: "content", original });
    }
  }
  return bindings;
}

function restoreOriginals(root: HTMLElement) {
  staticOptionLabels.restore(root);
  for (const node of collectTextNodes(root)) {
    const original = textSource(node);
    writeText(node, original, original);
  }
  for (const binding of collectAttributeBindings(root)) {
    if (binding.element.getAttribute(binding.name) !== binding.original) {
      writeAttribute(binding, binding.original);
    }
  }
  const originalTitle = titleSource();
  writeTitle(originalTitle, originalTitle);
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [locale, updateLocale] = useState<UiLocale>("en");
  // A delayed saved preference must not overwrite an explicit current choice.
  const explicitLocaleChoice = useRef(false);
  const [status, setStatus] = useState<TranslationStatus>("idle");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(languageStorageKey);
      if (saved === "zh-Hant") {
        window.localStorage.setItem(languageStorageKey, "zht");
        const timer = window.setTimeout(() => {
          if (!explicitLocaleChoice.current) updateLocale("zht");
        }, 0);
        return () => window.clearTimeout(timer);
      }
      if (isUiLocale(saved)) {
        const timer = window.setTimeout(() => {
          if (!explicitLocaleChoice.current) updateLocale(saved);
        }, 0);
        return () => window.clearTimeout(timer);
      }
    } catch {
      // Persistence is optional; the current session remains functional.
    }
  }, []);

  const setLocale = useCallback((nextLocale: UiLocale) => {
    explicitLocaleChoice.current = true;
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
    let rescanRequested = false;

    async function translateVisiblePage() {
      if (disposed) return;
      if (translating) {
        rescanRequested = true;
        return;
      }
      rescanRequested = false;
      translating = true;
      setStatus("loading");
      root.setAttribute("aria-busy", "true");
      try {
        const nodes = collectTextNodes(root);
        const attributes = collectAttributeBindings(root);
        const optionLabels = staticOptionLabels.collect(root);
        const pageTitle = titleSource();
        const sources = [
          ...new Set([
            ...nodes.map((node) => textSource(node).trim()),
            ...attributes.map((binding) => binding.original.trim()),
            ...optionLabels.map((binding) => binding.source.trim()),
            pageTitle.trim(),
          ]),
        ].filter(
          (source) =>
            isTranslatableSource(source) &&
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
            if (disposed) return;
            if (!response.ok) throw new Error("TRANSLATION_UNAVAILABLE");
            const payload = (await response.json()) as {
              degraded?: unknown;
              translations?: unknown;
            };
            if (disposed) return;
            if (
              !Array.isArray(payload.translations) ||
              payload.translations.length !== missing.length ||
              payload.translations.some(
                (value, index) => !isSafeUiTranslation(missing[index], value),
              )
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
            const original = textSource(node);
            if (!original) continue;
            const translated = cachedTranslation(locale, original.trim());
            if (translated) {
              const nextValue = renderTranslatedText(original, translated);
              writeText(node, original, nextValue);
            }
          }
          for (const binding of attributes) {
            const translated = cachedTranslation(
              locale,
              binding.original.trim(),
            );
            if (translated) writeAttribute(binding, translated);
          }
          const translatedTitle = cachedTranslation(locale, pageTitle.trim());
          for (const binding of optionLabels) {
            const translated = cachedTranslation(locale, binding.source.trim());
            if (translated) staticOptionLabels.write(binding, translated);
          }
          if (translatedTitle) writeTitle(pageTitle, translatedTitle);
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
        if (!disposed) {
          root.removeAttribute("aria-busy");
          if (rescanRequested) {
            window.clearTimeout(timer);
            timer = window.setTimeout(translateVisiblePage, 80);
          }
        }
      }
    }

    const observer = new MutationObserver((mutations) => {
      if (!mutations.some(needsSourceScan)) return;
      rescanRequested = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(translateVisiblePage, 80);
    });
    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        ...translatableAttributes,
        ...staticSelectMutationAttributes,
      ],
    });
    observer.observe(document.head, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["content"],
    });
    void translateVisiblePage();

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      staticOptionLabels.restore(root);
      window.clearTimeout(timer);
      root.removeAttribute("aria-busy");
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
