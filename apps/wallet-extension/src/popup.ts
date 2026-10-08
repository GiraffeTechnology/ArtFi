import { vaultSubmission } from "./vault-form.js";

/**
 * The popup is where a person grants a site access, because a site must not be able to grant
 * itself. The service worker refuses `site.*` messages from anything but an extension page.
 *
 * It is also the only place the coordinator vault is created or unlocked, which is what makes an
 * account available to a page at all.
 */

const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const siteElement = document.querySelector<HTMLParagraphElement>("#site");
const toggle = document.querySelector<HTMLButtonElement>("#toggle-site");
const grantList = document.querySelector<HTMLUListElement>("#grants");
const lock = document.querySelector<HTMLButtonElement>("#lock");
const vaultForm = document.querySelector<HTMLFormElement>("#vault-form");
const vaultPassword =
  document.querySelector<HTMLInputElement>("#vault-password");
const vaultPasswordLabel = document.querySelector<HTMLLabelElement>(
  "#vault-password-label",
);
const vaultAccountFields = document.querySelector<HTMLDivElement>(
  "#vault-account-fields",
);
const vaultAddress = document.querySelector<HTMLInputElement>("#vault-address");
const vaultConnector =
  document.querySelector<HTMLSelectElement>("#vault-connector");
const vaultSubmit = document.querySelector<HTMLButtonElement>("#vault-submit");
const vaultError = document.querySelector<HTMLParagraphElement>("#vault-error");

interface StoredGrant {
  origin: string;
  expiresAt: number;
}

interface VaultStatus {
  configured: boolean;
  locked: boolean;
}

let activeOrigin: string | null = null;
let activeTabId: number | null = null;
let grants: StoredGrant[] = [];
let vaultStatus: VaultStatus = { configured: false, locked: true };

async function send<T>(message: Record<string, unknown>): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as {
    ok: boolean;
    result?: T;
    error?: string;
  };
  if (!response.ok) throw new Error(response.error ?? "wallet error");
  return response.result as T;
}

/** Only an origin this wallet would talk to is offered; anything else is reported, not enabled. */
function readableOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const isLocalhost =
      parsed.protocol === "http:" && parsed.hostname === "localhost";
    if (parsed.protocol !== "https:" && !isLocalhost) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function renderSite(): void {
  if (!siteElement || !toggle) return;
  if (!activeOrigin) {
    siteElement.textContent = "This tab cannot use the wallet (HTTPS only).";
    toggle.hidden = true;
    return;
  }
  const enabled = grants.some((grant) => grant.origin === activeOrigin);
  siteElement.textContent = enabled
    ? `${activeOrigin} is enabled.`
    : `${activeOrigin} is not enabled.`;
  toggle.hidden = false;
  toggle.textContent = enabled
    ? "Disable for this site"
    : "Enable for this site";
  toggle.dataset.action = enabled ? "disable" : "enable";
}

function renderGrants(): void {
  if (!grantList) return;
  grantList.replaceChildren(
    ...grants.map((grant) => {
      const item = document.createElement("li");
      item.textContent = grant.origin;
      return item;
    }),
  );
}

/**
 * The vault form is the only path to an unlocked coordinator, and an unlocked coordinator is the
 * only source of an account. Without it the provider announces itself, a site can be enabled, and
 * every `eth_requestAccounts` still fails because no payload is ever in memory — a surface that
 * renders but cannot perform its function.
 *
 * A fresh install creates the vault, which needs the first account descriptor along with the
 * password; afterwards the same form only unlocks. No key material is involved either way: the
 * descriptor records which address an approved external signer holds.
 */
function renderVault(): void {
  if (
    !vaultForm ||
    !vaultSubmit ||
    !vaultAccountFields ||
    !vaultPasswordLabel
  ) {
    return;
  }
  if (!vaultStatus.locked) {
    vaultForm.hidden = true;
    return;
  }
  vaultForm.hidden = false;
  const creating = !vaultStatus.configured;
  vaultAccountFields.hidden = !creating;
  vaultSubmit.textContent = creating
    ? "Create coordinator vault"
    : "Unlock coordinator";
  vaultPasswordLabel.textContent = creating
    ? "New vault password (12 characters or more)"
    : "Vault password";
  if (vaultPassword) {
    vaultPassword.autocomplete = creating ? "new-password" : "current-password";
  }
  if (vaultAddress) vaultAddress.required = creating;
}

function showVaultError(message: string | null): void {
  if (!vaultError) return;
  vaultError.hidden = message === null;
  vaultError.textContent = message ?? "";
}

async function refresh(): Promise<void> {
  vaultStatus = await send<VaultStatus>({ type: "vault.status" });
  if (statusElement) {
    statusElement.textContent = !vaultStatus.configured
      ? "No encrypted connector vault configured."
      : vaultStatus.locked
        ? "Coordinator locked. Unlock it before a site can read an account."
        : "Coordinator unlocked for this browser session.";
  }
  grants = (await send<{ grants: StoredGrant[] }>({ type: "site.list" }))
    .grants;
  renderVault();
  renderSite();
  renderGrants();
}

vaultForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!vaultPassword) return;
  const submission = vaultSubmission({
    configured: vaultStatus.configured,
    password: vaultPassword.value,
    address: vaultAddress?.value ?? "",
    connector: vaultConnector?.value ?? "hardware",
  });
  if (submission.kind === "problem") {
    showVaultError(submission.reason);
    return;
  }
  const { password } = submission;
  const creating = submission.kind === "create";
  showVaultError(null);
  if (vaultSubmit) vaultSubmit.disabled = true;
  const message =
    submission.kind === "create"
      ? {
          type: "vault.create",
          password,
          payload: submission.payload,
        }
      : { type: "vault.unlock", password };
  void send(message)
    // Creating seals the vault and leaves it locked, so the same password unlocks it immediately
    // rather than making the person submit twice.
    .then(() =>
      creating ? send({ type: "vault.unlock", password }) : undefined,
    )
    .then(() => {
      vaultPassword.value = "";
      if (vaultAddress) vaultAddress.value = "";
      return refresh();
    })
    .catch((error: unknown) => {
      showVaultError(
        error instanceof Error
          ? error.message
          : "the vault could not be opened",
      );
    })
    .finally(() => {
      if (vaultSubmit) vaultSubmit.disabled = false;
    });
});

toggle?.addEventListener("click", () => {
  if (!activeOrigin) return;
  const action = toggle.dataset.action === "disable" ? "disable" : "enable";
  toggle.disabled = true;
  // The tab id lets the service worker run the provider in the page that is already open; without
  // it the registration would only take effect on the next load.
  void send({
    type: `site.${action}`,
    origin: activeOrigin,
    ...(action === "enable" && activeTabId !== null
      ? { tabId: activeTabId }
      : {}),
  })
    .then(refresh)
    .catch((error: unknown) => {
      if (siteElement) {
        siteElement.textContent =
          error instanceof Error ? error.message : "site access failed";
      }
    })
    .finally(() => {
      toggle.disabled = false;
    });
});

lock?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "vault.lock" }).then(refresh);
});

void chrome.tabs
  .query({ active: true, currentWindow: true })
  .then((tabs) => {
    activeOrigin = readableOrigin(tabs[0]?.url);
    activeTabId = tabs[0]?.id ?? null;
  })
  .catch(() => {
    activeOrigin = null;
    activeTabId = null;
  })
  .finally(() => {
    void refresh();
  });
