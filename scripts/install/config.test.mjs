import assert from "node:assert/strict";
import { test } from "node:test";
import { configure, validate, secretKeys } from "./config.mjs";

test("configuration creates unique operator-side secrets, retaining existing ones", () => {
  const first = configure(),
    second = configure();
  assert.equal(validate(first).errors.length, 0);
  for (const key of secretKeys) {
    assert.ok(first[key].length >= 32);
    assert.notEqual(first[key], second[key]);
  }
  assert.equal(
    configure({ PORT: "3900" }, first).ARTFI_USER_SESSION_SECRET,
    first.ARTFI_USER_SESSION_SECRET,
  );
});
test("URLs and ports are configurable without vendor host restrictions", () => {
  const config = configure({
    PORT: "8443",
    HOSTNAME: "::",
    ARTFI_API_ADDR: "[::1]:9080",
    ARTFI_WEB_URL: "https://artfi.example.test:8443/path",
    ARTFI_API_URL: "https://bridge.example.test:9443/artfi",
  });
  assert.equal(config.ARTFI_WEB_ORIGIN, "https://artfi.example.test:8443");
  assert.deepEqual(validate(config).errors, []);
});
test("missing optional integrations do not fail validation", () => {
  const result = validate(configure());
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length >= 3);
});
test("rejects plaintext signing keys, malformed fields and partial enabled integrations", () => {
  assert.ok(
    validate(
      configure({
        PORT: "99999",
        ARTFI_API_ADDR: "host:0",
        ARTFI_RPC_URL: "javascript:alert(1)",
        ARTFI_TEST_PRIVATE_KEY: "not-a-key",
        ARTFI_MIRROR_ENABLED: "true",
      }),
    ).errors.length >= 5,
  );
  assert.ok(
    validate(configure({ NEXT_PUBLIC_SECRET: "do-not-expose" })).errors.length,
  );
});
test("NFT scope JSON is validated and empty scopes remain available as unconfigured", () => {
  const config = configure({
    ARTFI_NFT_COLLECTIONS_JSON: JSON.stringify([
      {
        slug: "collection",
        chain: "base",
        contract: "0x" + "1".repeat(40),
        standard: "erc721",
        label: "Collection",
        charity: false,
      },
    ]),
  });
  assert.deepEqual(validate(config).errors, []);
  config.ARTFI_NFT_COLLECTIONS_JSON = "{}";
  assert.ok(
    validate(config).errors.some((error) =>
      error.startsWith("ARTFI_NFT_COLLECTIONS_JSON"),
    ),
  );
});

test("moderation role is a bounded optional application wallet configuration", () => {
  const config = configure({ ARTFI_ADMIN_WALLETS: "0x" + "1".repeat(40) });
  assert.deepEqual(validate(config).errors, []);
  for (const invalid of [
    "operator",
    "0x" + "0".repeat(40),
    config.ARTFI_ADMIN_WALLETS + ",invalid",
  ]) {
    assert.ok(
      validate({ ...config, ARTFI_ADMIN_WALLETS: invalid }).errors.some(
        (error) => error.startsWith("ARTFI_ADMIN_WALLETS"),
      ),
    );
  }
});

test("approved RWA source configuration accepts only public roots and isolates TEST_ONLY", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const source = {
    id: "example-source",
    name: "Example custody source",
    kind: "custody",
    mode: "LIVE",
    publicKeyX: "0x" + Buffer.from(jwk.x, "base64url").toString("hex"),
    publicKeyY: "0x" + Buffer.from(jwk.y, "base64url").toString("hex"),
    registryBacked: false,
  };
  const config = configure({
    ARTFI_RWA_APPROVED_SOURCES_JSON: JSON.stringify([source]),
  });
  assert.deepEqual(validate(config).errors, []);
  for (const malformed of [
    [{ ...source, privateKey: "never-accepted" }],
    [source, source],
    [{ ...source, publicKeyY: "0x" + "00".repeat(32) }],
    [{ ...source, mode: "TEST_ONLY" }],
  ]) {
    assert.ok(
      validate({
        ...config,
        ARTFI_RWA_APPROVED_SOURCES_JSON: JSON.stringify(malformed),
      }).errors.some((error) =>
        error.startsWith("ARTFI_RWA_APPROVED_SOURCES_JSON"),
      ),
    );
  }
  const testOnly = {
    ...config,
    ARTFI_RWA_EVIDENCE_MODE: "TEST_ONLY",
    ARTFI_RWA_APPROVED_SOURCES_JSON: JSON.stringify([
      { ...source, mode: "TEST_ONLY" },
    ]),
  };
  assert.ok(
    validate(testOnly).errors.some((error) => error.includes("isolated")),
  );
  assert.deepEqual(validate({ ...testOnly, ARTFI_ENV: "test" }).errors, []);
});

test("optional operator multisig binds the same public and server safe", () => {
  const safe = "0x" + "1".repeat(40);
  assert.deepEqual(
    validate(
      configure({
        ARTFI_ADMIN_SAFE_ADDRESS: safe,
        NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS: safe,
      }),
    ).errors,
    [],
  );
  for (const input of [
    { ARTFI_ADMIN_SAFE_ADDRESS: safe },
    { NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS: safe },
    {
      ARTFI_ADMIN_SAFE_ADDRESS: safe,
      NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS: "0x" + "2".repeat(40),
    },
    {
      ARTFI_ADMIN_SAFE_ADDRESS: "0x" + "0".repeat(40),
      NEXT_PUBLIC_ARTFI_ADMIN_SAFE_ADDRESS: "0x" + "0".repeat(40),
    },
  ])
    assert.ok(
      validate(configure(input)).errors.some((message) =>
        message.includes("ARTFI_ADMIN_SAFE_ADDRESS"),
      ),
    );
});

test("optional operations services require explicit settings without enabling by default", () => {
  const c = configure();
  assert.equal(c.ARTFI_AGENT_ENABLED, "false");
  assert.equal(c.ARTFI_MONITOR_ENABLED, "false");
  assert.ok(
    validate(configure({ ARTFI_AGENT_ENABLED: "true" })).errors.some((x) =>
      x.includes("ARTFI_AGENT_CONFIG_FILE"),
    ),
  );
  assert.ok(
    validate(
      configure({
        ARTFI_MONITOR_ENABLED: "true",
        ARTFI_MONITOR_CONFIG_FILE: "relative.json",
      }),
    ).errors.some((x) => x.includes("ARTFI_MONITOR_CONFIG_FILE")),
  );
  assert.deepEqual(
    validate(
      configure({
        ARTFI_AGENT_ENABLED: "true",
        ARTFI_AGENT_CONFIG_FILE: "/private/agent.json",
        ARTFI_AGENT_API_URL: "http://127.0.0.1:31001",
        ARTFI_MONITOR_ENABLED: "true",
        ARTFI_MONITOR_CONFIG_FILE: "/private/monitor.json",
      }),
    ).errors,
    [],
  );
});

test("existing disabled configurations remain upgrade-compatible before agent setup", () => {
  const c = configure();
  delete c.ARTFI_AGENT_BRIDGE_TOKEN;
  delete c.ARTFI_AGENT_ENABLED;
  delete c.ARTFI_MONITOR_ENABLED;
  assert.deepEqual(validate(c).errors, []);
  c.ARTFI_AGENT_ENABLED = "true";
  c.ARTFI_AGENT_CONFIG_FILE = "/private/agent.json";
  c.ARTFI_AGENT_API_URL = "http://127.0.0.1:31001";
  assert.ok(
    validate(c).errors.some((x) => x.includes("ARTFI_AGENT_BRIDGE_TOKEN")),
  );
});
