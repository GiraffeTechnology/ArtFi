import React, { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  LanguageProvider,
  useLanguage,
} from "../../../src/components/language-provider";
import { StaticSelectLabels } from "../../../src/lib/static-select-labels";

declare global {
  interface Window {
    fixture: {
      locale: ReturnType<typeof useLanguage>["setLocale"];
      labels: StaticSelectLabels;
      events: string[];
    };
  }
}

function Fixture() {
  const { setLocale, status } = useLanguage();
  useLayoutEffect(() => {
    window.fixture = { ...window.fixture, locale: setLocale };
  }, [setLocale]);
  return (
    <>
      <output id="status" data-no-translate>
        {status}
      </output>
      <form id="form">
        <select
          id="public"
          name="public"
          defaultValue="active"
          data-translate-options="static"
        >
          <option value="all">All states</option>
          <option value="active" label="Active at snapshot">
            Authoritative raw text
          </option>
        </select>
        <select id="implicit" name="implicit" data-translate-options="static">
          <option>Implicit choice</option>
        </select>
        <select id="private" name="private">
          <option value="secret">Private account label</option>
        </select>
        <select id="skipped" data-translate-options="static" data-no-translate>
          <option>Skipped label</option>
        </select>
        <select id="group" data-translate-options="static">
          <optgroup data-translation-skip>
            <option>Group choice</option>
          </optgroup>
        </select>
      </form>
    </>
  );
}
window.fixture = {
  locale: () => {},
  labels: new StaticSelectLabels(),
  events: [],
};
for (const event of ["input", "change"])
  document.addEventListener(event, () => window.fixture.events.push(event));
createRoot(document.getElementById("root")!).render(
  <LanguageProvider>
    <Fixture />
  </LanguageProvider>,
);
