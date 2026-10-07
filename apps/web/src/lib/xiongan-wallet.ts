/** Public DApp navigation only; deployment configuration is never a session. */
export type XionganWalletConfig =
  | { ok: true; url: string }
  | { ok: false; code: "NOT_CONFIGURED" | "INVALID_CONFIG" };

export function parseXionganWalletURL(value: unknown): XionganWalletConfig {
  if (value === undefined || value === null || value === "")
    return { ok: false, code: "NOT_CONFIGURED" };
  if (typeof value !== "string" || value.trim() === "")
    return { ok: false, code: "INVALID_CONFIG" };
  try {
    const url = new URL(value);
    if (
      value !== value.trim() ||
      /[\u0000-\u0020\u007f\\]/.test(value) ||
      !/^https:\/\//i.test(value) ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return { ok: false, code: "INVALID_CONFIG" };
    // Preserve the deployment's complete URL, including its explicit port/path.
    // Do not compose a host/port, normalize away a supplied port or add payloads.
    return { ok: true, url: value };
  } catch {
    return { ok: false, code: "INVALID_CONFIG" };
  }
}

export const XIONGAN_WALLET_DISCLOSURE =
  "Opens the separate Xiongan DApp in a new tab. Opening it does not connect a wallet to ArtFi. Connect your browser wallet separately in each app.";
