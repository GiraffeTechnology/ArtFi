# Static public option labels

This standalone Chromium fixture imports the real LanguageProvider and StaticSelectLabels helper. Only the pathname hook is replaced. Translation replies are controlled test data; every request is intercepted, and other origins are rejected. This verifies DOM behavior, source isolation, asynchronous restoration and form semantics. It does not establish real translation-model quality, a full Next build, live API integration or financial acceptance.

Run only on an existing approved remote Linux server, using its installed Node, Vite, Playwright and Chromium. No installation is needed or performed. From apps/web, set ARTFI_STATIC_SELECT_VITE_MODULE to that installed Vite entry, ARTFI_STATIC_SELECT_OUTPUT to a task-owned output directory, ARTFI_STATIC_SELECT_FIXTURE to its fixture.js, and ARTFI_E2E_CHROMIUM_PATH to the existing browser executable. Then run:

```sh
node scripts/build-static-select-fixture.mjs
node node_modules/@playwright/test/cli.js test --config playwright.static-select.config.ts
```

The separate test directory and config keep this fixture out of default application e2e discovery. Production selects opt in with data-translate-options="static" only for fixed public text. Unmarked selects and skipped ancestors stay excluded. Translations use the option label attribute; raw text, explicit and implicit values, selection and events remain authoritative. Do not mark account, wallet, user-generated or other private labels as static public text.
