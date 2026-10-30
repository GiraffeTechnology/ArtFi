# Server-side mirror catalog search

The existing read-only market asset endpoint accepts q, listingStatus (all, active, inactive), sort (newest, oldest, token), page and pageSize. Count and page queries use the same ranked catalog and parameterized filters, so search and ordering apply across the catalog before pagination. Search treats percent, underscore and the escape character literally. Sort clauses are chosen from fixed strings; full decimal token IDs are ordered by length and lexical value rather than floating-point or a narrowing decimal cast. Existing source approval and contract filters remain.

The UI fetches only its requested page and validates the exact applied search/filter/order, page position and row count. It can jump to the last page above the previous complete-scan limit, while the earlier bounded complete-scan helper remains available with its refusal behavior. Pages are capped at one million and page size at one hundred; the UI uses twelve rows and tells users to narrow searches beyond its bounded page range. Offset pages remain observations, not an atomic snapshot or current listing eligibility. No trade, funds, signature or custody authority comes from this endpoint.

The standalone e2e-market-server fixture imports the real catalog component and readers. Next link and font wrappers are test adapters; API requests are intercepted with synthetic envelopes and every other origin is rejected. Build it from apps/web on an existing approved remote Linux server with the installed Vite entry in ARTFI_MARKET_VITE_MODULE and task output path in ARTFI_MARKET_OUTPUT. Set ARTFI_MARKET_FIXTURE to the resulting fixture.js, ARTFI_E2E_CHROMIUM_PATH to its existing browser, then run:

```sh
node scripts/build-market-server-fixture.mjs
node node_modules/@playwright/test/cli.js test --config playwright.market-server.config.ts
```

This fixture checks actual browser query wiring, cancellation, timeout and result-state handling. It does not substitute for Go compilation, real MySQL query execution, actual upstream API data, a full Next application build or complete product acceptance. Preserve those evidence layers separately.
