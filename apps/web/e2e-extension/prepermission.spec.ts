import { test, expect, type ExtensionAPI } from "./fixtures";

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
