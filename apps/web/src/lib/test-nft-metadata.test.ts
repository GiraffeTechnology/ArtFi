import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, HEAD } from "../app/api/test-nft/metadata/[sha256]/route";
import {
  serveTestNFTMetadata,
  testNFTMetadataDescription,
  testNFTMetadataNames,
  type TestNFTMetadataConfig,
} from "./test-nft-metadata";

const directories: string[] = [];
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
function metadata(kind: 0 | 1 = 0) {
  return {
    name: testNFTMetadataNames[kind],
    description: testNFTMetadataDescription,
    properties: {
      testOnly: true,
      chainId: 560048,
      assetKind: kind,
      sourceSha256: "a".repeat(64),
      realWorldValue: false,
      legalTitle: false,
      institutionalSourceEvidence: false,
    },
  };
}

async function fixture(bytes = encode(metadata())) {
  const root = await mkdtemp(join(tmpdir(), "artfi-test-metadata-"));
  directories.push(root);
  const sha = digest(bytes);
  const manifestPath = join(root, "manifest.json");
  const metadataPath = join(root, `${sha}.json`);
  const manifest = {
    schema: "artfi-test-nft-metadata/1",
    chainId: 560048,
    hashes: [sha],
  };
  await writeFile(manifestPath, encode(manifest));
  await writeFile(metadataPath, bytes);
  const config: TestNFTMetadataConfig = {
    environment: "test",
    chainId: "560048",
    manifestPath,
  };
  return { root, sha, bytes, config, manifestPath, metadataPath, manifest };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("reviewed public test metadata artifact", () => {
  it.each([0, 1] as const)(
    "serves original kind %s bytes with privacy and JSON headers",
    async (kind) => {
      const f = await fixture(encode(metadata(kind)));
      const response = await serveTestNFTMetadata(f.sha, f.config);
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.equals(f.bytes)).toBe(true);
      expect(digest(bytes)).toBe(f.sha);
      expect(response.headers.get("content-length")).toBe(
        String(f.bytes.length),
      );
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await readFile(f.metadataPath)).toEqual(f.bytes);
    },
  );

  it.each([
    { environment: undefined, chainId: "560048" },
    { environment: "production", chainId: "560048" },
    { environment: "test", chainId: "1" },
    { environment: "test", chainId: "11155111" },
    { environment: "test", chainId: undefined },
  ])(
    "does not activate from a different or incomplete deployment: %j",
    async (scope) => {
      const response = await serveTestNFTMetadata("a".repeat(64), {
        ...scope,
        manifestPath: "/not-a-configured-artifact/manifest.json",
      });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("manifest.json");
    },
  );

  it.each([
    "../manifest",
    "0x" + "a".repeat(64),
    "A".repeat(64),
    "0".repeat(64),
    "a".repeat(65),
    "a".repeat(63),
    "%2e%2e%2f",
  ])("rejects an invalid path digest %s", async (sha) => {
    const f = await fixture();
    expect((await serveTestNFTMetadata(sha, f.config)).status).toBe(404);
  });

  it("does not serve an existing file outside the reviewed allowlist", async () => {
    const f = await fixture();
    await writeFile(
      f.manifestPath,
      encode({ ...f.manifest, hashes: ["b".repeat(64)] }),
    );
    expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(404);
  });

  it("requires an explicit absolute artifact reference", async () => {
    const f = await fixture();
    for (const manifestPath of [undefined, "manifest.json"]) {
      const response = await serveTestNFTMetadata(f.sha, {
        ...f.config,
        manifestPath,
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toBe(
        '{"detail":"Test metadata is unavailable."}',
      );
    }
  });

  it.each([
    { schema: "wrong", chainId: 560048, hashes: ["a".repeat(64)] },
    {
      schema: "artfi-test-nft-metadata/1",
      chainId: 1,
      hashes: ["a".repeat(64)],
    },
    { schema: "artfi-test-nft-metadata/1", chainId: 560048, hashes: [] },
    {
      schema: "artfi-test-nft-metadata/1",
      chainId: 560048,
      hashes: ["0".repeat(64)],
    },
    {
      schema: "artfi-test-nft-metadata/1",
      chainId: 560048,
      hashes: ["a".repeat(64), "a".repeat(64)],
    },
    {
      schema: "artfi-test-nft-metadata/1",
      chainId: 560048,
      hashes: ["a".repeat(64)],
      file: "outside.json",
    },
  ])("rejects an invalid or expanded manifest %j", async (manifest) => {
    const f = await fixture();
    await writeFile(f.manifestPath, encode(manifest));
    expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
  });

  it("bounds a manifest before parsing it", async () => {
    const f = await fixture();
    await writeFile(f.manifestPath, Buffer.alloc(16_385, 32));
    expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
  });

  it("rejects swapped metadata instead of returning a changed body", async () => {
    const f = await fixture();
    await writeFile(f.metadataPath, encode(metadata(1)));
    const response = await serveTestNFTMetadata(f.sha, f.config);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(testNFTMetadataNames[1]);
  });

  it("reports a missing allowlisted object without exposing its filename", async () => {
    const f = await fixture();
    await rm(f.metadataPath);
    const response = await serveTestNFTMetadata(f.sha, f.config);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(f.sha);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a directory where metadata should be", async () => {
    const f = await fixture();
    await rm(f.metadataPath);
    await mkdir(f.metadataPath);
    expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
  });

  it.each(["manifestPath", "metadataPath"] as const)(
    "refuses a final symlink at %s",
    async (key) => {
      const f = await fixture();
      await rename(f[key], f[key] + ".original");
      await symlink(f[key] + ".original", f[key]);
      expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
    },
  );

  it("bounds the metadata read even when its digest is allowlisted", async () => {
    const f = await fixture(Buffer.alloc(8_193, 32));
    expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
  });

  it.each([
    Buffer.from(JSON.stringify(metadata())),
    Buffer.from(encode(metadata()).toString().replace(/\n/g, "\r\n")),
    Buffer.from(
      encode(metadata())
        .toString()
        .replace('"name":', '"name": "discarded",\n  "name":'),
    ),
    Buffer.from(
      encode(metadata()).toString().replace("TESTNET", "TESTNET\\u0020"),
    ),
  ])(
    "does not normalize or rewrite noncanonical incoming bytes",
    async (bytes) => {
      const f = await fixture(bytes);
      expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
      expect(await readFile(f.metadataPath)).toEqual(bytes);
    },
  );

  it.each([
    "testOnly",
    "realWorldValue",
    "legalTitle",
    "institutionalSourceEvidence",
  ] as const)("rejects a changed test assertion %s", async (key) => {
    const value = metadata();
    value.properties[key] = !value.properties[key];
    const f = await fixture(encode(value));
    expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
  });

  it("rejects image, private-file and arbitrary metadata extensions", async () => {
    for (const extension of [
      { image: "https://example.invalid/master.png" },
      { holderFile: "private-file" },
      { external_url: "https://example.invalid" },
    ]) {
      const f = await fixture(encode({ ...metadata(), ...extension }));
      expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
    }
  });

  it("does not accept a different source profile or free-text assertion", async () => {
    const values = [
      {
        ...metadata(),
        description: testNFTMetadataDescription + " Additional rights.",
      },
      { ...metadata(), properties: { ...metadata().properties, assetKind: 2 } },
      {
        ...metadata(),
        properties: { ...metadata().properties, sourceSha256: "0".repeat(64) },
      },
      { ...metadata(), properties: { ...metadata().properties, chainId: 1 } },
    ];
    for (const value of values) {
      const f = await fixture(encode(value));
      expect((await serveTestNFTMetadata(f.sha, f.config)).status).toBe(503);
    }
  });

  it("rejects request query parameters and uses server-owned configuration", async () => {
    const f = await fixture();
    vi.stubEnv("ARTFI_ENV", "test");
    vi.stubEnv("ARTFI_CHAIN_ID", "560048");
    vi.stubEnv("ARTFI_TEST_NFT_METADATA_MANIFEST", f.manifestPath);
    const context = { params: Promise.resolve({ sha256: f.sha }) };
    const response = await GET(
      new Request(
        `https://example.invalid/api/test-nft/metadata/${f.sha}?file=master`,
      ),
      context,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const head = await HEAD(
      new Request(`https://example.invalid/api/test-nft/metadata/${f.sha}`),
      context,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(String(f.bytes.length));
    vi.stubEnv("ARTFI_ENV", "production");
    const request = new Request(
      `https://example.invalid/api/test-nft/metadata/${f.sha}`,
      { headers: { "x-artfi-env": "test", "x-chain-id": "560048" } },
    );
    expect((await GET(request, context)).status).toBe(404);
  });
});
