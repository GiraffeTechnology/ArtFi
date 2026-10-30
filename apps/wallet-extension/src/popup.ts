import { vaultSubmission } from "./vault-form.js";
import {
  isPopupLocale,
  popupLanguages,
  popupLanguageStorageKey,
  popupMessageKeys,
  popupMessage,
  resolvePopupLocale,
  vaultProblemKey,
  type PopupLocale,
  type PopupMessageKey,
} from "./popup-language.js";

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
let locale: PopupLocale = resolvePopupLocale(undefined, navigator.languages);
let vaultErrorKey: PopupMessageKey | null = null;
let statusOverride: PopupMessageKey | null = "checking";
let tabRead = false;
let siteFailed = false;
let languageRevision = 0;
let languageSave = Promise.resolve();
let preferenceNotice: PopupMessageKey | null = null;
const language = document.querySelector<HTMLSelectElement>("#language");
const languageStatus =
  document.querySelector<HTMLParagraphElement>("#language-status");
const translatedBoundary = document.querySelector<HTMLParagraphElement>(
  "#translated-boundary",
);
const emptyGrants =
  document.querySelector<HTMLParagraphElement>("#grants-empty");
const message = (key: PopupMessageKey, origin = "") =>
  popupMessage(locale, key, origin);

function renderStatus(): void {
  if (statusElement)
    statusElement.textContent = message(
      statusOverride ??
        (!vaultStatus.configured
          ? "unconfigured"
          : vaultStatus.locked
            ? "locked"
            : "unlocked"),
    );
}
function renderLanguage(): void {
  document.documentElement.lang = locale;
  document
    .querySelectorAll<HTMLElement>("[data-popup-message]")
    .forEach((element) => {
      const key = element.dataset.popupMessage;
      if (key && popupMessageKeys.some((known) => known === key)) {
        // Keys are fixed by this extension's own markup, never supplied by a page.
        element.textContent = message(key as PopupMessageKey);
      }
    });
  if (language) language.value = locale;
  if (translatedBoundary) translatedBoundary.hidden = locale === "en";
  if (languageStatus)
    languageStatus.textContent = preferenceNotice
      ? message(preferenceNotice)
      : "";
  renderStatus();
  renderVault();
  renderSite();
  renderGrants();
  showVaultError(vaultErrorKey);
}
if (language) {
  language.replaceChildren(
    ...popupLanguages.map(({ value, label }) => {
      const option = document.createElement("option");
      option.value = value;
      option.lang = value;
      option.textContent = label;
      return option;
    }),
  );
  language.addEventListener("change", () => {
    if (!isPopupLocale(language.value)) return;
    locale = language.value;
    const selected = locale;
    const revision = ++languageRevision;
    preferenceNotice = null;
    renderLanguage();
    // Serialize writes so an older selection cannot overwrite a newer one.
    languageSave = languageSave
      .catch(() => undefined)
      .then(async () => {
        try {
          await chrome.storage.local.set({
            [popupLanguageStorageKey]: selected,
          });
          if (revision === languageRevision)
            preferenceNotice = "preferenceSaved";
        } catch {
          if (revision === languageRevision)
            preferenceNotice = "preferenceUnsaved";
        }
        if (revision === languageRevision && languageStatus)
          languageStatus.textContent = preferenceNotice
            ? message(preferenceNotice)
            : "";
      });
  });
}
renderLanguage();
const initialLanguageRevision = languageRevision;
void chrome.storage.local
  .get(popupLanguageStorageKey)
  .then((stored) => {
    if (languageRevision !== initialLanguageRevision) return;
    locale = resolvePopupLocale(
      stored[popupLanguageStorageKey],
      navigator.languages,
    );
    renderLanguage();
  })
  .catch(() => {
    if (languageRevision !== initialLanguageRevision) return;
    preferenceNotice = "preferenceUnsaved";
    renderLanguage();
  });

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
  if (!tabRead) {
    siteElement.textContent = message("readingTab");
    toggle.hidden = true;
    return;
  }
  if (!activeOrigin) {
    siteElement.textContent = message("unsupportedSite");
    toggle.hidden = true;
    return;
  }
  if (siteFailed || statusOverride) {
    siteElement.textContent = message("siteFailure");
    toggle.hidden = true;
    return;
  }
  const enabled = grants.some((grant) => grant.origin === activeOrigin);
  siteElement.textContent = message(
    enabled ? "siteEnabled" : "siteDisabled",
    activeOrigin,
  );
  toggle.hidden = false;
  toggle.textContent = message(enabled ? "disable" : "enable");
  toggle.dataset.action = enabled ? "disable" : "enable";
}

function renderGrants(): void {
  if (!grantList) return;
  if (emptyGrants)
    emptyGrants.hidden = grants.length !== 0 || statusOverride !== null;
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
  if (statusOverride || !vaultStatus.locked) {
    vaultForm.hidden = true;
    return;
  }
  vaultForm.hidden = false;
  const creating = !vaultStatus.configured;
  vaultAccountFields.hidden = !creating;
  vaultSubmit.textContent = message(creating ? "create" : "unlock");
  vaultPasswordLabel.textContent = message(
    creating ? "newPassword" : "password",
  );
  if (vaultPassword) {
    vaultPassword.autocomplete = creating ? "new-password" : "current-password";
  }
  if (vaultAddress) vaultAddress.required = creating;
}

function showVaultError(key: PopupMessageKey | null): void {
  vaultErrorKey = key;
  if (!vaultError) return;
  vaultError.hidden = key === null;
  vaultError.textContent = key ? message(key) : "";
}
function showRefreshFailure(): void {
  statusOverride = "refreshFailure";
  grants = [];
  renderLanguage();
}

async function refresh(): Promise<void> {
  const nextStatus = await send<VaultStatus>({ type: "vault.status" });
  const nextGrants = (
    await send<{ grants: StoredGrant[] }>({ type: "site.list" })
  ).grants;
  vaultStatus = nextStatus;
  grants = nextGrants;
  statusOverride = null;
  siteFailed = false;
  renderStatus();
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
    showVaultError(vaultProblemKey(submission.reason));
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
    .catch(() => {
      showVaultError("vaultFailure");
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
    .catch(() => {
      siteFailed = true;
      renderSite();
    })
    .finally(() => {
      toggle.disabled = false;
    });
});

lock?.addEventListener("click", () => {
  void chrome.runtime
    .sendMessage({ type: "vault.lock" })
    .then(refresh)
    .catch(showRefreshFailure);
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
    tabRead = true;
    void refresh().catch(showRefreshFailure);
  });
