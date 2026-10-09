import { randomBytes, ECDH } from "node:crypto";

export const secretKeys = [
  "ARTFI_INDEXER_SHARED_KEY",
  "ARTFI_OPERATOR_BEARER_TOKEN",
  "ARTFI_OPERATOR_SESSION_SECRET",
  "ARTFI_CHARITY_HOLDER_SESSION_SECRET",
  "ARTFI_USER_AUTH_BRIDGE_TOKEN",
  "ARTFI_USER_SESSION_SECRET",
];
export const defaults = {
  ARTFI_ENV: "production",
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: "3000",
  ARTFI_API_ADDR: "127.0.0.1:8080",
  ARTFI_API_URL: "http://127.0.0.1:8080",
  ARTFI_WEB_URL: "http://127.0.0.1:3000",
  ARTFI_WEB_ORIGIN: "http://127.0.0.1:3000",
  NEXT_PUBLIC_API_URL: "",
  ARTFI_CHAIN_ID: "560048",
  ARTFI_USER_AUTH_CHAIN_IDS: "560048",
  ARTFI_MARKETPLACE_ALLOWLIST: "opensea",
  ARTFI_ADMIN_WALLETS: "",
  ARTFI_ADMIN_SAFE_ADDRESS: "",
  NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS: "",
  ARTFI_RWA_APPROVED_SOURCES_JSON: "[]",
  ARTFI_RWA_EVIDENCE_MODE: "LIVE",
  ARTFI_NFT_COLLECTIONS_JSON: "[]",
  ARTFI_NFT_TRADING_ENABLED: "false",
  ARTFI_EXTERNAL_TRADE_ENABLED: "false",
  ARTFI_MIRROR_ENABLED: "false",
  ARTFI_AGENT_ENABLED: "false",
  ARTFI_AGENT_CONFIG_FILE: "",
  ARTFI_AGENT_API_URL: "",
  ARTFI_MONITOR_ENABLED: "false",
  ARTFI_MONITOR_CONFIG_FILE: "",
  MYSQL_DSN: "",
  REDIS_URL: "",
};
export function configure(input = {}, previous = {}) {
  const config = { ...defaults, ...previous, ...input };
  for (const key of [...secretKeys, "ARTFI_AGENT_BRIDGE_TOKEN"])
    if (!config[key]) config[key] = randomBytes(48).toString("base64url");
  config.ARTFI_WEB_ORIGIN = new URL(config.ARTFI_WEB_URL).origin;
  return config;
}
export function validate(config) {
  const errors = [],
    warnings = [];
  if (!config || typeof config !== "object" || Array.isArray(config))
    return { errors: ["Configuration must be a JSON object."], warnings };
  for (const [key, value] of Object.entries(config)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      typeof value !== "string" ||
      /[\0\r\n]/.test(value)
    )
      errors.push(`${key}: expected a single-line string environment setting.`);
    if (/(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE)/.test(key) && value)
      errors.push(
        `${key}: signing material is not supported in the ArtFi service configuration.`,
      );
    if (
      key.startsWith("NEXT_PUBLIC_") &&
      /(?:SECRET|TOKEN$|KEY|PASSWORD)/.test(key) &&
      !key.endsWith("_TOKEN_ID")
    )
      errors.push(`${key}: credentials must never be public.`);
  }
  for (const key of secretKeys)
    if (typeof config[key] !== "string" || config[key].length < 32)
      errors.push(`${key}: at least 32 characters are required.`);
  const port = Number(config.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    errors.push("PORT: must be an integer from 1 to 65535.");
  if (
    !/^(?:[^\s:]+|\[[0-9a-fA-F:]+\])?:[0-9]{1,5}$/.test(
      config.ARTFI_API_ADDR || "",
    ) ||
    +config.ARTFI_API_ADDR.split(":").at(-1) < 1 ||
    +config.ARTFI_API_ADDR.split(":").at(-1) > 65535
  )
    errors.push("ARTFI_API_ADDR: expected host:port, [IPv6]:port, or :port.");
  if (!config.HOSTNAME || /[\s/\0]/.test(config.HOSTNAME))
    errors.push("HOSTNAME: expected a listener hostname or IP address.");
  const urlKeys = [
    "ARTFI_API_URL",
    "ARTFI_AGENT_API_URL",
    "ARTFI_WEB_URL",
    "ARTFI_WEB_ORIGIN",
    "ARTFI_USER_AUTH_API_URL",
    "ARTFI_OPERATOR_API_URL",
    "ARTFI_ORACLE_READ_API_URL",
    "ARTFI_XIONGAN_WALLET_URL",
    "ARTFI_RPC_URL",
    "ARTFI_NFT_RPC_1",
    "ARTFI_NFT_RPC_8453",
    "GIRAFFE_LANGUAGE_URL",
    "NEXT_PUBLIC_API_URL",
    "NEXT_PUBLIC_HOODI_RPC_URL",
    "NEXT_PUBLIC_BASE_RPC_URL",
    "NEXT_PUBLIC_ETHEREUM_RPC_URL",
  ];
  for (const key of urlKeys) {
    if (!config[key]) continue;
    if (key === "NEXT_PUBLIC_API_URL" && /^\/(?!\/)[^\s]*$/.test(config[key]))
      continue;
    try {
      const url = new URL(config[key]);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error();
      if (
        key === "ARTFI_XIONGAN_WALLET_URL" &&
        (url.protocol !== "https:" || url.search)
      )
        throw new Error();
    } catch {
      errors.push(
        `${key}: use a complete HTTP(S) URL without embedded credentials or fragments; wallet URL requires HTTPS and no query.`,
      );
    }
  }
  try {
    if (new URL(config.ARTFI_WEB_URL).origin !== config.ARTFI_WEB_ORIGIN)
      errors.push(
        "ARTFI_WEB_ORIGIN must match the exact ARTFI_WEB_URL origin.",
      );
  } catch {
    errors.push("ARTFI_WEB_URL: a valid public origin is required.");
  }
  for (const [key, value] of Object.entries(config))
    if (key.endsWith("_ADDRESS") && value && !/^0x[0-9a-fA-F]{40}$/.test(value))
      errors.push(`${key}: expected an EVM address.`);
  if (
    config.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID &&
    !/^(0|[1-9][0-9]*)$/.test(config.NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID)
  )
    errors.push(
      "NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_TOKEN_ID: expected an unsigned decimal integer.",
    );
  for (const key of [
    "ARTFI_NFT_TRADING_ENABLED",
    "ARTFI_EXTERNAL_TRADE_ENABLED",
    "ARTFI_MIRROR_ENABLED",
  ])
    if (!["true", "false"].includes(config[key]))
      errors.push(`${key}: expected true or false.`);
  if (
    !/^(?:1|8453|560048)(?:,(?:1|8453|560048))*$/.test(
      config.ARTFI_USER_AUTH_CHAIN_IDS || "",
    )
  )
    errors.push(
      "ARTFI_USER_AUTH_CHAIN_IDS: expected comma-separated supported chain IDs 1,8453,560048.",
    );
  try {
    const scopes = JSON.parse(config.ARTFI_NFT_COLLECTIONS_JSON || "[]"),
      seen = new Set();
    if (!Array.isArray(scopes) || scopes.length > 100) throw new Error();
    for (const scope of scopes) {
      if (
        !scope ||
        Object.keys(scope).some(
          (key) =>
            ![
              "slug",
              "chain",
              "contract",
              "standard",
              "label",
              "charity",
            ].includes(key),
        ) ||
        !/^[a-z0-9][a-z0-9-]{0,99}$/.test(scope.slug) ||
        seen.has(scope.slug) ||
        !["ethereum", "base"].includes(scope.chain) ||
        !/^0x[0-9a-fA-F]{40}$/.test(scope.contract) ||
        /^0x0{40}$/i.test(scope.contract) ||
        !["erc721", "erc1155"].includes(scope.standard) ||
        typeof scope.label !== "string" ||
        !scope.label.trim() ||
        scope.label.length > 160 ||
        typeof scope.charity !== "boolean"
      )
        throw new Error();
      seen.add(scope.slug);
    }
  } catch {
    errors.push(
      "ARTFI_NFT_COLLECTIONS_JSON: expected valid uniquely named NFT collection scopes.",
    );
  }
  const privateSafe = config.ARTFI_ADMIN_SAFE_ADDRESS || "";
  const publicSafe = config.NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS || "";
  if (privateSafe || publicSafe) {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(privateSafe) ||
      /^0x0{40}$/i.test(privateSafe) ||
      privateSafe.toLowerCase() !== publicSafe.toLowerCase()
    ) {
      errors.push(
        "ARTFI_ADMIN_SAFE_ADDRESS and NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS must name the same nonzero configured safe, or both remain empty for direct operation.",
      );
    }
  }
  if (config.ARTFI_ADMIN_WALLETS) {
    const addresses = config.ARTFI_ADMIN_WALLETS.split(",").map((value) =>
      value.trim(),
    );
    if (
      addresses.some(
        (value) =>
          !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value),
      )
    )
      errors.push(
        "ARTFI_ADMIN_WALLETS: expected comma-separated nonzero application-moderator wallet addresses; this grants no trading or registrar role.",
      );
  } else {
    warnings.push(
      "Application moderation is not configured; set ARTFI_ADMIN_WALLETS to enable the admin console. User reporting still requires MySQL and wallet sessions.",
    );
  }
  if (!["LIVE", "TEST_ONLY"].includes(config.ARTFI_RWA_EVIDENCE_MODE))
    errors.push("ARTFI_RWA_EVIDENCE_MODE: expected LIVE or TEST_ONLY.");
  if (
    config.ARTFI_RWA_EVIDENCE_MODE === "TEST_ONLY" &&
    config.ARTFI_ENV !== "test"
  )
    errors.push(
      "TEST_ONLY RWA evidence requires an isolated ARTFI_ENV=test installation.",
    );
  try {
    const sources = JSON.parse(config.ARTFI_RWA_APPROVED_SOURCES_JSON || "[]");
    const ids = new Set();
    if (!Array.isArray(sources) || sources.length > 100) throw new Error();
    for (const source of sources) {
      if (
        !source ||
        Object.keys(source).some(
          (key) =>
            ![
              "id",
              "name",
              "kind",
              "publicKeyX",
              "publicKeyY",
              "mode",
              "registryBacked",
              "disabled",
            ].includes(key),
        ) ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.id) ||
        ids.has(source.id) ||
        typeof source.name !== "string" ||
        source.name.trim() !== source.name ||
        source.name.length < 2 ||
        source.name.length > 160 ||
        ![
          "registry",
          "warehouse",
          "custody",
          "certificate",
          "provenance",
        ].includes(source.kind) ||
        source.mode !== config.ARTFI_RWA_EVIDENCE_MODE ||
        !/^0x[0-9a-fA-F]{64}$/.test(source.publicKeyX) ||
        !/^0x[0-9a-fA-F]{64}$/.test(source.publicKeyY) ||
        (source.registryBacked !== undefined &&
          typeof source.registryBacked !== "boolean") ||
        (source.disabled !== undefined && typeof source.disabled !== "boolean")
      )
        throw new Error();
      ECDH.convertKey(
        Buffer.from(
          "04" + source.publicKeyX.slice(2) + source.publicKeyY.slice(2),
          "hex",
        ),
        "prime256v1",
      );
      ids.add(source.id);
    }
    if (!sources.length)
      warnings.push(
        "RWA source trust is unconfigured. Source-dependent minting and activation remain unavailable; digital NFT and other independent functions are unaffected.",
      );
  } catch {
    errors.push(
      "ARTFI_RWA_APPROVED_SOURCES_JSON: expected unique approved-source identities and valid public P-256 keys only. Signing secrets are never accepted.",
    );
  }
  if (
    config.ARTFI_SOURCE_AUTHORITY &&
    (!/^0x[0-9a-fA-F]{40}$/.test(config.ARTFI_SOURCE_AUTHORITY) ||
      /^0x0{40}$/i.test(config.ARTFI_SOURCE_AUTHORITY))
  )
    errors.push(
      "ARTFI_SOURCE_AUTHORITY: expected the independent source authority's public address.",
    );
  if (!config.MYSQL_DSN)
    warnings.push(
      "MySQL is not configured; persistent workflows will report unavailable.",
    );
  if (!config.OPENSEA_API_KEY)
    warnings.push(
      "OpenSea is not configured; unrelated product sections remain available.",
    );
  if (config.ARTFI_NFT_TRADING_ENABLED === "true" && !config.OPENSEA_API_KEY)
    errors.push(
      "OPENSEA_API_KEY is required when native NFT trading is enabled.",
    );
  if (config.ARTFI_MIRROR_ENABLED === "true") {
    for (const key of [
      "OPENSEA_API_KEY",
      "OPENSEA_COLLECTION_SLUGS",
      "ARTFI_INDEXER_SHARED_KEY",
    ])
      if (!config[key])
        errors.push(`${key}: required by the enabled market mirror.`);
    if (config.ARTFI_PUBLIC_CHAIN_EXECUTION_ZONE !== "sin")
      errors.push(
        "The existing market mirror requires the configured SIN execution zone.",
      );
  }
  for (const feature of ["AGENT", "MONITOR"]) {
    const enabled = `ARTFI_${feature}_ENABLED`;
    if (!["true", "false"].includes(config[enabled] ?? "false"))
      errors.push(`${enabled}: expected true or false.`);
    if (config[enabled] === "true") {
      const key = `ARTFI_${feature}_CONFIG_FILE`;
      if (!config[key]?.startsWith("/"))
        errors.push(
          `${key}: an explicit absolute configuration-file path is required.`,
        );
      if (
        feature === "AGENT" &&
        (typeof config.ARTFI_AGENT_BRIDGE_TOKEN !== "string" ||
          config.ARTFI_AGENT_BRIDGE_TOKEN.length < 32)
      )
        errors.push(
          "ARTFI_AGENT_BRIDGE_TOKEN: at least 32 characters are required by the enabled runtime.",
        );
      if (feature === "AGENT" && !config.ARTFI_AGENT_API_URL)
        errors.push(
          "ARTFI_AGENT_API_URL: required by the enabled agent runtime.",
        );
    }
  }
  if (!config.ARTFI_XIONGAN_WALLET_URL)
    warnings.push("The independent wallet entry is not configured.");
  return { errors, warnings };
}
