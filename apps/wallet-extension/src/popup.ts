export {};

/**
 * The popup is where a person grants a site access, because a site must not be able to grant
 * itself. The service worker refuses `site.*` messages from anything but an extension page.
 */

const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const siteElement = document.querySelector<HTMLParagraphElement>("#site");
const toggle = document.querySelector<HTMLButtonElement>("#toggle-site");
const grantList = document.querySelector<HTMLUListElement>("#grants");
const lock = document.querySelector<HTMLButtonElement>("#lock");

interface StoredGrant {
  origin: string;
  expiresAt: number;
}

let activeOrigin: string | null = null;
let grants: StoredGrant[] = [];

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

async function refresh(): Promise<void> {
  const vault = await send<{ configured: boolean; locked: boolean }>({
    type: "vault.status",
  });
  if (statusElement) {
    statusElement.textContent = !vault.configured
      ? "No encrypted connector vault configured."
      : vault.locked
        ? "Coordinator locked. Unlock it before a site can read an account."
        : "Coordinator unlocked for this browser session.";
  }
  grants = (await send<{ grants: StoredGrant[] }>({ type: "site.list" }))
    .grants;
  renderSite();
  renderGrants();
}

toggle?.addEventListener("click", () => {
  if (!activeOrigin) return;
  const action = toggle.dataset.action === "disable" ? "disable" : "enable";
  toggle.disabled = true;
  void send({ type: `site.${action}`, origin: activeOrigin })
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
  })
  .catch(() => {
    activeOrigin = null;
  })
  .finally(() => {
    void refresh();
  });
