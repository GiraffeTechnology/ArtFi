/** Public deployment settings only. Never add server credentials to this allowlist. */
export const publicRuntimeKeys = [
  "NEXT_PUBLIC_API_URL",
  "NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS",
  "NEXT_PUBLIC_ARTFI_CHARITY_EDITIONS_ADDRESS",
  "NEXT_PUBLIC_ARTFI_DAO_ACTIONS_ADDRESS",
  "NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS",
  "NEXT_PUBLIC_ARTFI_FRACTION_SLUG",
  "NEXT_PUBLIC_ARTFI_FRACTION_TOKEN_ADDRESS",
  "NEXT_PUBLIC_ARTFI_GOVERNANCE_TOKEN_ADDRESS",
  "NEXT_PUBLIC_ARTFI_GOVERNOR_ADDRESS",
  "NEXT_PUBLIC_ARTFI_RWA_VAULT_ADDRESS",
  "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_COLLECTION_ADDRESS",
  "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS",
  "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_SLUG",
  "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID",
  "NEXT_PUBLIC_ETHEREUM_RPC_URL",
  "NEXT_PUBLIC_BASE_RPC_URL",
  "NEXT_PUBLIC_HOODI_RPC_URL",
] as const;

export type PublicRuntimeKey = (typeof publicRuntimeKeys)[number];
export type PublicRuntimeConfig = Partial<Record<PublicRuntimeKey, string>>;

declare global {
  interface Window {
    __ARTFI_PUBLIC_CONFIG__?: PublicRuntimeConfig;
  }
}

/** Dynamic indexing deliberately prevents Next.js build-time environment substitution. */
export function publicSetting(name: PublicRuntimeKey): string | undefined {
  if (typeof window !== "undefined")
    return window.__ARTFI_PUBLIC_CONFIG__?.[name];
  return process.env[name];
}

export function publicRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): PublicRuntimeConfig {
  return Object.fromEntries(
    publicRuntimeKeys.flatMap((name) =>
      environment[name] ? [[name, environment[name]]] : [],
    ),
  );
}

/** Escape HTML delimiters as well as JavaScript line separators in the inline bootstrap. */
export function publicRuntimeScript(config: PublicRuntimeConfig): string {
  return `window.__ARTFI_PUBLIC_CONFIG__=${JSON.stringify(config).replace(
    /[<>&\u2028\u2029]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )};`;
}
