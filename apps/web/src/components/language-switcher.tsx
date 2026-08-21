"use client";

import { uiLocaleOptions, type UiLocale } from "@/lib/language";

import { useLanguage } from "./language-provider";

export function LanguageSwitcher() {
  const { locale, setLocale } = useLanguage();
  const controlLabel =
    locale === "zh" || locale === "zht" ? "语言" : "Language";

  return (
    <label
      className="language-switcher"
      data-no-translate
      data-translation-skip
    >
      <span className="sr-only">{controlLabel}</span>
      <select
        aria-label={controlLabel}
        onChange={(event) => setLocale(event.target.value as UiLocale)}
        value={locale}
      >
        {uiLocaleOptions.map((option) => (
          <option
            aria-label={option.accessibleName}
            key={option.locale}
            lang={option.htmlLang}
            value={option.locale}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
