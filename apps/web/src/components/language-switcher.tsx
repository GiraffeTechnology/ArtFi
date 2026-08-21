"use client";

import {
  accessibleLanguageNameFor,
  uiLocaleOptions,
  type UiLocale,
} from "@/lib/language";

import { useLanguage } from "./language-provider";

export function LanguageSwitcher() {
  const { locale, setLocale, status } = useLanguage();

  return (
    <label
      className={`language-switcher language-switcher--${status}`}
      data-no-translate
    >
      <span className="sr-only">Language / 语言</span>
      <span className="language-switcher__icon" aria-hidden="true">
        文
      </span>
      <select
        aria-label={`Language: ${accessibleLanguageNameFor(locale)}`}
        aria-busy={status === "loading"}
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
