import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

test("manual retry fixture crosses a poll tick before the real request deadline", () => {
  const production = read("apps/web/src/components/live-market-catalog.tsx");
  const deadline = Number(
    production.match(/controller\.abort\(\);\s*\}, (\d+)\)/)[1],
  );
  const period = Number(
    production
      .match(/setInterval\(\(\) => void loadCatalog\(\), ([\d_]+)\)/)[1]
      .replaceAll("_", ""),
  );
  const fixture = read("apps/web/e2e/market-unavailable.spec.ts");
  const manual = fixture.slice(fixture.indexOf('if (recovery === "manual") {'));
  const advances = [...manual.matchAll(/fastForward\(([\d_]+)\)/g)]
    .slice(0, 2)
    .map((match) => Number(match[1].replaceAll("_", "")));
  const [startAfterPoll, heldDuration] = advances;
  assert.ok(startAfterPoll > 0 && startAfterPoll < period);
  assert.ok(
    startAfterPoll + heldDuration >= period,
    "must cross a poll tick while held",
  );
  assert.ok(
    heldDuration < deadline,
    "must release before production abort deadline",
  );
  assert.ok(
    manual.indexOf("expect(requests).toBe(failedRequests + 1)") <
      manual.indexOf("releaseRetry?.()"),
  );
});

test("head fixture installs both authoritative mutations after locale selection", () => {
  const fixture = read("apps/web/e2e/dynamic-language.spec.ts").split(
    'test("head and attribute changes',
  )[1];
  assert.ok(
    fixture.indexOf('selectOption("fr")') <
      fixture.indexOf('document.title = "ArtFi pending Dogwood"'),
  );
  for (const title of ["pending", "confirmed"]) {
    assert.ok(fixture.includes(`toHaveTitle("[fr] ArtFi ${title} Dogwood")`));
  }
});

test("production title writer preserves new authoritative sources and rejects stale writes", () => {
  const source = read("apps/web/src/components/language-provider.tsx");
  const capture = source.slice(
    source.indexOf("function captureSource("),
    source.indexOf("function textSource("),
  );
  const title = source.slice(
    source.indexOf("function titleSource()"),
    source.indexOf("function needsSourceScan("),
  );
  const context = vm.createContext({
    document: { title: "Original layout title" },
  });
  vm.runInContext(
    stripTypeScriptTypes(
      `type SourceBinding = { original: string; rendered: string }; let pageTitleBinding: SourceBinding | undefined; let writtenTitle: string | undefined; ${capture}\n${title}`,
    ),
    context,
  );
  vm.runInContext(
    'titleSource(); document.title = "ArtFi pending Dogwood"; writeTitle("ArtFi pending Dogwood", "[fr] ArtFi pending Dogwood");',
    context,
  );
  assert.equal(context.document.title, "[fr] ArtFi pending Dogwood");
  vm.runInContext(
    'document.title = "ArtFi confirmed Dogwood"; writeTitle("ArtFi pending Dogwood", "[fr] ArtFi pending Dogwood");',
    context,
  );
  assert.equal(context.document.title, "ArtFi confirmed Dogwood");
  vm.runInContext(
    'writeTitle("ArtFi confirmed Dogwood", "[fr] ArtFi confirmed Dogwood");',
    context,
  );
  assert.equal(context.document.title, "[fr] ArtFi confirmed Dogwood");
});
