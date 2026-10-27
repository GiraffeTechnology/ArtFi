import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";

// Exercise the actual initialization callbacks with a deterministic scheduler,
// without mounting a UI or running a browser.
const source = readFileSync(
  new URL(
    "../../apps/web/src/components/language-provider.tsx",
    import.meta.url,
  ),
  "utf8",
);
const start = source.indexOf("  const [locale, updateLocale]");
const end = source.indexOf(
  "  useEffect(() => {\n    document.documentElement.lang",
  start,
);
assert.ok(start >= 0 && end > start);
const callbacks = stripTypeScriptTypes(source.slice(start, end));
function harness(saved) {
  let current = "en";
  const effects = [],
    timers = [];
  const storage = new Map([["artfi-ui-language", saved]]);
  const controls = vm.runInNewContext(callbacks + "\n({ setLocale })", {
    useState: (initial) => [
      initial,
      (value) => {
        if (initial === "en") current = value;
      },
    ],
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
    isUiLocale: (value) => ["en", "zht", "fr"].includes(value),
    languageStorageKey: "artfi-ui-language",
    window: {
      localStorage: {
        getItem: (key) => storage.get(key),
        setItem: (key, value) => storage.set(key, value),
      },
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    },
  });
  return { controls, effects, timers, current: () => current, storage };
}
for (const saved of ["en", "zh-Hant"]) {
  test(`explicit locale wins over delayed saved ${saved}`, () => {
    const h = harness(saved);
    h.effects[0]();
    h.controls.setLocale("fr");
    h.timers[0]();
    assert.equal(h.current(), "fr");
    assert.equal(h.storage.get("artfi-ui-language"), "fr");
  });
  test(`saved ${saved} still initializes an untouched session`, () => {
    const h = harness(saved);
    h.effects[0]();
    h.timers[0]();
    assert.equal(h.current(), saved === "zh-Hant" ? "zht" : saved);
  });
}
