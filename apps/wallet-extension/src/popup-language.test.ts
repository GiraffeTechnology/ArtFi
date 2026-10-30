import { describe, expect, it } from "vitest";
import {
  isPopupLocale,
  popupLanguages,
  popupLanguageStorageKey,
  popupMessage,
  popupMessageKeys,
  resolvePopupLocale,
  vaultProblemKey,
} from "./popup-language.js";

describe("extension popup language preference", () => {
  it("honours only a supported explicit preference before browser language", () => {
    expect(resolvePopupLocale("fr", ["ja-JP"])).toBe("fr");
    for (const stored of [null, {}, "__proto__", "fr<script>", 1])
      expect(resolvePopupLocale(stored, ["unknown", "de-DE"])).toBe("de");
    expect(resolvePopupLocale(undefined, ["unknown"])).toBe("en");
    expect(popupLanguageStorageKey).toBe("artfi.popup.locale.v1");
    expect(isPopupLocale("constructor")).toBe(false);
  });
  it("distinguishes Chinese scripts and regional fallbacks", () => {
    for (const tag of ["zh-Hant", "zh-TW", "zh_HK", "zh-MO"])
      expect(resolvePopupLocale(undefined, [tag])).toBe("zh-Hant");
    for (const tag of ["zh-Hans", "zh-CN", "zh-SG", "zh-Hans-TW"])
      expect(resolvePopupLocale(undefined, [tag])).toBe("zh-Hans");
    expect(resolvePopupLocale(undefined, ["en-GB", "ja"])).toBe("en");
    expect(resolvePopupLocale(undefined, ["ko-KR"])).toBe("ko");
  });
  it("provides every popup message in all eight languages", () => {
    expect(popupLanguages.map((entry) => entry.value)).toEqual([
      "en",
      "zh-Hans",
      "zh-Hant",
      "fr",
      "es",
      "de",
      "ko",
      "ja",
    ]);
    for (const { value } of popupLanguages) {
      for (const key of popupMessageKeys) {
        const text = popupMessage(value, key);
        expect(text.trim().length).toBeGreaterThan(0);
        expect(text).not.toMatch(/<\/?(?:script|img|iframe)\b/i);
      }
      expect(popupMessage(value, "boundary")).toContain("Hoodi");
      expect(popupMessage(value, "boundary")).toContain("WalletConnect");
    }
  });
  it("keeps origin data literal for the popup's text-only renderer", () => {
    const origin = "https://test.invalid/<img>$&";
    for (const { value } of popupLanguages) {
      expect(popupMessage(value, "siteEnabled", origin)).toContain(origin);
      expect(popupMessage(value, "siteDisabled", origin)).toContain(origin);
      expect(popupMessage(value, "siteEnabled", origin)).not.toContain(
        "{origin}",
      );
    }
  });
  it("maps only known validation reasons and never exposes unknown diagnostics", () => {
    expect(
      vaultProblemKey("the vault password must contain at least 12 characters"),
    ).toBe("passwordMinimum");
    expect(
      vaultProblemKey("an account address is required to create the vault"),
    ).toBe("addressRequired");
    const key = vaultProblemKey("PRIVATE_DIAGNOSTIC_TEST_ONLY");
    expect(key).toBe("vaultFailure");
    for (const { value } of popupLanguages)
      expect(popupMessage(value, key)).not.toContain(
        "PRIVATE_DIAGNOSTIC_TEST_ONLY",
      );
  });
});
