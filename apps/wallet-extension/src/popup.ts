export {};

const statusElement = document.querySelector<HTMLParagraphElement>("#status");
const lock = document.querySelector<HTMLButtonElement>("#lock");

async function refresh(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "vault.status",
  })) as {
    ok: boolean;
    result?: { configured: boolean; locked: boolean };
  };
  if (!statusElement) return;
  statusElement.textContent = !response.result?.configured
    ? "No encrypted connector vault configured."
    : response.result.locked
      ? "Coordinator locked."
      : "Coordinator unlocked for this browser session.";
}

lock?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "vault.lock" }).then(refresh);
});

void refresh();
