# Installed Chromium extension acceptance

This is an additive, isolated check of the actual built unpacked extension. It is
not the web suite's injected/mock provider, and a green **prepermission** job is
not full installed-provider acceptance. It traces the existing wallet integration
and explicit user approval boundaries in `AGENTS.md`; it creates no new product gate.

## Run

From the repository root, after the normal frozen-lockfile install:

```sh
pnpm --filter @giraffetechnology/artfi-wallet-extension build
pnpm --filter @giraffetechnology/artfi-web exec playwright install --with-deps chromium
pnpm --filter @giraffetechnology/artfi-web exec playwright test --config=playwright.extension.config.ts --project=prepermission
```

The additional quality job runs only that explicitly named project. The original
eight jobs are unchanged. Chromium is the **full Playwright-bundled browser** via
`channel: "chromium"`, not `--only-shell`, a system-browser override, or an extension
simulation. Each test launches a new persistent temporary profile, enables the
Chromium sandbox explicitly, then closes and deletes its own profile. A sandbox,
worker startup, manifest, or popup failure fails the check rather than skipping it.
This requires an ordinary runner where sandboxed Chromium can start; it does not
try `--no-sandbox` or other security workarounds in restricted containers.

The tests compare the built manifest byte-for-byte with the production manifest
and assert that scripting and host access remain optional and ungranted. They
check the real extension worker URL; render the real popup module; create, lock,
reject a wrong password, unlock, reload the popup, and lock again using only a
public synthetic address and disposable test-only passphrase. No key, real vault,
signer session, RPC, transaction, or account is used. Only the local ephemeral
HTTP fixture is navigated. Page traffic outside localhost/the extension is
aborted; this route is not a claim of browser-wide/service-worker network isolation.
No extension flow in this test initiates external network traffic.

Opening `popup.html` in a tab changes the active tab. This is deliberate for the
vault-only check: the test asserts that site enablement is unavailable there. It
must not be represented as a toolbar-popup/localhost integration test. The
unapproved fixture page is checked for absence of provider announcements before
and after reload; this negative check is not evidence of successful injection.

## Explicit permission boundary

The default and CI configuration include only the prepermission project. The
permission-dependent continuation is not implemented or run by this job; no
intentionally failing or silently skipped authorization test is included. Its
unverified steps are listed below and are not represented as passed.

The existing application would request API permission `scripting` and the pattern
`http://localhost:<ephemeral-port>/*`; the unchanged manifest declares optional
host access `http://localhost/*`, which allows wildcard localhost ports. The
application would request the explicit ephemeral origin/port pattern above; the
manifest's allowed optional scope is not an approved grant. The scope Chromium
actually grants must be read back and verified; supplying a port in a request is
not itself evidence of port-bounded browser permission. Application authorization
continues to use the exact browser-reported origin. No permission request
has been made. Before a real request/acceptance, report the actual origin and
requested pattern to the owner. Stop for their explicit approval. Never preseed grants, edit profile preferences, auto-accept a
prompt, turn optional permission into required permission, override permissions
APIs, or inject the provider in the test to manufacture success.

After appropriate approval, separately implement/verify the bounded continuation
in an interactive isolated browser. Use the real toolbar popup while the localhost
tab remains active. `chrome.action.openPopup()` is documented from Chrome 127,
but programmatically opening it alone must not be assumed to confer `activeTab`
or satisfy the `permissions.request()` user-gesture requirement. Verify the actual
popup displays the intended origin. The current popup sends `site.enable` to the
service worker, which requests permission after asynchronous grant restoration;
whether that preserves a browser-recognized gesture is an unverified runtime
question, not something to hide with a test override.

Remaining coverage: actual permission prompt/approval, immediate MAIN/ISOLATED
injection, EIP-6963 discovery, read-only accounts and chain, lock/unlock events,
reload/reconnect, worker restart/rehydration, site disable and grant expiry. Missing
permission or a popup/gesture failure must remain a named blocked/failing result.
No full-acceptance or production-readiness claim follows from this harness alone.

Official references:

- <https://playwright.dev/docs/chrome-extensions>
- <https://developer.chrome.com/docs/extensions/reference/api/action#method-openPopup>
- <https://developer.chrome.com/docs/extensions/reference/api/permissions#method-request>
- <https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns>

## Restart isolation checks

The same prepermission CI project also includes two synthetic-only restart tests.
One observes the actual extension worker through Chrome DevTools Protocol,
selects its exact script URL/version ID, calls `ServiceWorker.stopWorker`, requires
a subsequent `stopped` event, and wakes it through the real popup. It then requires
a later `running` event for that version. This exercises forced termination and
restart, not the timing of idle suspension. Worker transitions are attached to the
test result. An unavailable CDP target or a missing transition fails the test.

The other closes the entire persistent browser context and relaunches the same
full sandboxed Chromium against only that test's temporary profile. The profile
is removed after final teardown. Both tests begin with an unlocked synthetic
coordinator, send no `vault.lock` message, require the restored popup to show
locked, compare the complete persisted encrypted record for equality, and verify
that the correct disposable test passphrase still unlocks it. They assert no
scripting/host grant and no plaintext synthetic address/passphrase in storage.
No worker or browser restart is inferred from a popup reload alone.

These tests do not cover granted-site/provider restoration and do not alter the
existing optional-permission approval boundary. Runtime results must come from
the new exact-head CI run; static checks or earlier green runs are not proof that
the new restart tests passed.

References: <https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/#method-stopWorker>
and <https://playwright.dev/docs/chrome-extensions#service-worker-idle-suspension-mv3>.
