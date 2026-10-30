import {
  test,
  expect,
  type ExtensionAPI,
  type InstalledExtension,
} from "./fixtures";
import type { Worker } from "@playwright/test";

const publicSyntheticAddress = "0x1111111111111111111111111111111111111111";
const testOnlyPassphrase = "ARTFI_TEST_ONLY_disposable_profile";

test("real worker and popup vault lifecycle without granting site access", async ({
  installed,
  origin,
}) => {
  const { context, worker, extensionId } = installed;
  const site = await context.newPage();
  await site.goto(origin);
  const assertNoProvider = async () => {
    expect(
      await site.evaluate(() => {
        window.dispatchEvent(new Event("eip6963:requestProvider"));
        return (window as unknown as { artfiAnnouncements: string[] })
          .artfiAnnouncements;
      }),
    ).toEqual([]);
  };
  await assertNoProvider();

  // A tab is sufficient for vault UI, NOT for active-tab site enablement.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("#status")).toHaveText(
    "No encrypted connector vault configured.",
  );
  await expect(popup.locator("#site")).toHaveText(
    "This tab cannot use the wallet (HTTPS only).",
  );
  await expect(popup.locator("#toggle-site")).toBeHidden();
  await expect(popup.locator("#grants li")).toHaveCount(0);

  await popup.locator("#vault-password").fill(testOnlyPassphrase);
  await popup.locator("#vault-address").fill(publicSyntheticAddress);
  await popup.locator("#vault-connector").selectOption("hardware");
  await popup.getByRole("button", { name: "Create coordinator vault" }).click();
  await expect(popup.locator("#status")).toHaveText(
    "Coordinator unlocked for this browser session.",
  );
  await expect(popup.locator("#vault-password")).toHaveValue("");
  await expect(popup.locator("#vault-address")).toHaveValue("");
  await popup
    .getByRole("button", { name: "Lock coordinator", exact: true })
    .click();
  await expect(popup.locator("#status")).toContainText("Coordinator locked.");
  await popup.locator("#vault-password").fill("wrong_TEST_ONLY_password");
  await popup
    .getByRole("button", { name: "Unlock coordinator", exact: true })
    .click();
  await expect(popup.locator("#vault-error")).toBeVisible();
  await expect(popup.locator("#status")).toContainText("Coordinator locked.");
  await popup.locator("#vault-password").fill(testOnlyPassphrase);
  await popup
    .getByRole("button", { name: "Unlock coordinator", exact: true })
    .click();
  await expect(popup.locator("#status")).toHaveText(
    "Coordinator unlocked for this browser session.",
  );
  await popup.reload();
  await expect(popup.locator("#status")).toHaveText(
    "Coordinator unlocked for this browser session.",
  );
  await popup
    .getByRole("button", { name: "Lock coordinator", exact: true })
    .click();
  await expect(popup.locator("#status")).toContainText("Coordinator locked.");

  const state = await worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ExtensionAPI }).chrome;
    return {
      permissions: await chrome.permissions.getAll(),
      stored: await chrome.storage.local.get([
        "artfiSiteGrants",
        "artfiEncryptedVault",
      ]),
    };
  });
  expect(state.permissions.permissions).not.toContain("scripting");
  expect(state.permissions.origins ?? []).toEqual([]);
  expect(state.stored.artfiSiteGrants ?? []).toEqual([]);
  expect(state.stored.artfiEncryptedVault).toMatchObject({
    version: 1,
    algorithm: "AES-GCM",
  });
  const storedText = JSON.stringify(state.stored);
  expect(storedText).not.toContain(publicSyntheticAddress);
  expect(storedText).not.toContain(testOnlyPassphrase);
  await site.reload();
  await assertNoProvider();
});

async function createSyntheticVault(installed: InstalledExtension) {
  const popup = await installed.context.newPage();
  await popup.goto(`chrome-extension://${installed.extensionId}/popup.html`);
  await expect(popup.locator("#status")).toHaveText(
    "No encrypted connector vault configured.",
  );
  await popup.locator("#vault-password").fill(testOnlyPassphrase);
  await popup.locator("#vault-address").fill(publicSyntheticAddress);
  await popup.locator("#vault-connector").selectOption("hardware");
  await popup.getByRole("button", { name: "Create coordinator vault" }).click();
  await expect(popup.locator("#status")).toHaveText(
    "Coordinator unlocked for this browser session.",
  );
  return popup;
}

async function readPersistedState(worker: Worker) {
  return worker.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: ExtensionAPI }).chrome;
    return {
      permissions: await chrome.permissions.getAll(),
      stored: await chrome.storage.local.get([
        "artfiEncryptedVault",
        "artfiSiteGrants",
      ]),
    };
  });
}

async function expectPersistedLockedVault(
  installed: InstalledExtension,
  before: Awaited<ReturnType<typeof readPersistedState>>,
) {
  const popup = await installed.context.newPage();
  await popup.goto(`chrome-extension://${installed.extensionId}/popup.html`);
  await expect(popup.locator("#status")).toHaveText(
    "Coordinator locked. Unlock it before a site can read an account.",
  );
  await expect(popup.locator("#vault-account-fields")).toBeHidden();
  await expect(
    popup.getByRole("button", { name: "Unlock coordinator", exact: true }),
  ).toBeVisible();
  // MV3 idle restart normally preserves the handle; a forced CDP stop can
  // instead detach its target. Select the current real worker after the popup
  // response, supporting either browser behavior without assuming a new event.
  const restoredWorker = installed.context
    .serviceWorkers()
    .find((worker) => worker.url() === installed.worker.url());
  expect(restoredWorker).toBeDefined();
  const after = await readPersistedState(restoredWorker!);
  expect(after.stored.artfiEncryptedVault).toEqual(
    before.stored.artfiEncryptedVault,
  );
  expect(after.stored.artfiEncryptedVault).toMatchObject({
    version: 1,
    algorithm: "AES-GCM",
  });
  expect(after.stored.artfiSiteGrants ?? []).toEqual([]);
  expect(after.permissions.permissions).not.toContain("scripting");
  expect(after.permissions.origins ?? []).toEqual([]);
  expect(JSON.stringify(after.stored)).not.toContain(publicSyntheticAddress);
  expect(JSON.stringify(after.stored)).not.toContain(testOnlyPassphrase);
  await popup.locator("#vault-password").fill(testOnlyPassphrase);
  await popup
    .getByRole("button", { name: "Unlock coordinator", exact: true })
    .click();
  await expect(popup.locator("#status")).toHaveText(
    "Coordinator unlocked for this browser session.",
  );
}

test("worker termination preserves encrypted vault but discards in-memory unlock", async ({
  installed,
}, testInfo) => {
  const popup = await createSyntheticVault(installed);
  const before = await readPersistedState(installed.worker);
  const cdp = await installed.context.newCDPSession(popup);
  type WorkerVersion = {
    versionId: string;
    scriptURL: string;
    runningStatus: string;
  };
  const versions = new Map<string, WorkerVersion>();
  const transitions: WorkerVersion[] = [];
  cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updates }) => {
    for (const version of updates as WorkerVersion[]) {
      if (version.scriptURL !== installed.worker.url()) continue;
      versions.set(version.versionId, version);
      transitions.push({
        versionId: version.versionId,
        scriptURL: version.scriptURL,
        runningStatus: version.runningStatus,
      });
    }
  });
  try {
    await cdp.send("ServiceWorker.enable");
    await expect
      .poll(() =>
        [...versions.values()].some(
          (version) => version.runningStatus === "running",
        ),
      )
      .toBe(true);
    const running = [...versions.values()].find(
      (version) => version.runningStatus === "running",
    )!;
    // Stop the actual extension worker, not its runtime listener, popup, vault,
    // or a test double. No vault.lock message is sent in this test.
    const stopRequestedAt = transitions.length;
    await cdp.send("ServiceWorker.stopWorker", {
      versionId: running.versionId,
    });
    await expect
      .poll(() =>
        transitions
          .slice(stopRequestedAt)
          .some(
            (version) =>
              version.versionId === running.versionId &&
              version.runningStatus === "stopped",
          ),
      )
      .toBe(true);
    const stoppedAt = transitions.findIndex(
      (version, index) =>
        index >= stopRequestedAt &&
        version.versionId === running.versionId &&
        version.runningStatus === "stopped",
    );
    // Opening the real popup wakes the worker by runtime messages. Playwright
    // may retain the Worker handle or replace it after forced target detachment;
    // the helper selects the current worker without awaiting a new SW event.
    await expectPersistedLockedVault(installed, before);
    await expect
      .poll(() =>
        transitions
          .slice(stoppedAt + 1)
          .some(
            (version) =>
              version.versionId === running.versionId &&
              version.runningStatus === "running",
          ),
      )
      .toBe(true);
  } finally {
    await testInfo.attach("extension-worker-transitions", {
      body: JSON.stringify(transitions, null, 2),
      contentType: "application/json",
    });
    await cdp.detach();
  }
});

test("same-profile browser restart preserves encrypted vault but discards in-memory unlock", async ({
  installed,
}) => {
  await createSyntheticVault(installed);
  const before = await readPersistedState(installed.worker);
  // No vault.lock message: closing the browser must discard the unlocked
  // coordinator while leaving its encrypted record in this disposable profile.
  const restarted = await installed.restartBrowser();
  expect(restarted.context).not.toBe(installed.context);
  expect(restarted.extensionId).toBe(installed.extensionId);
  await expectPersistedLockedVault(restarted, before);
});
