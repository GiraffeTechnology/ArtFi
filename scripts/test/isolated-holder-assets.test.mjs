import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ISOLATED_TEST_MARKERS } from "../release/lib/isolated-hoodi-payload.mjs";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const digest = (n) => n.toString(16).padStart(64, "0");
const address = (n) => "0x" + n.toString(16).padStart(40, "0");
const description =
  ISOLATED_TEST_MARKERS.join(" | ") +
  ". Separately AI-generated abstract technical payload for Ethereum Hoodi. No association with real charitable donations, receipts, physical title, redemption, valuation, artist identity or holder benefits.";
async function baseFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "artfi-holder-input-"));
  t.after(async () => {
    assert(root.startsWith(join(tmpdir(), "artfi-holder-input-")));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "source-art"));
  await mkdir(join(root, "metadata"));
  const m = {
    schema: "artfi-private-isolated-ai-input/v1",
    namespace: "TESTNET-AI-HOODI-FIXTURE",
    chainId: 560048,
    testAssetMarkers: [...ISOLATED_TEST_MARKERS],
    status: "GENERATED_INPUTS_ONLY_NOT_DEPLOYED",
    sourceArtVisibility: "PRIVATE_TEST_INPUT_NO_PUBLIC_ARTWORK_PREVIEW",
    generationTool: "built-in image_gen",
    generationEventTimestamps: "SYNTHETIC_FIXTURE",
    imageInspection: { method: "SYNTHETIC_HEADER_FIXTURE_NOT_ART" },
    artworks: [],
    deployment: {
      status: "NOT_DEPLOYED",
      collectionAddress: null,
      adminSafeAddress: null,
      transactionHash: null,
      description: ISOLATED_TEST_MARKERS.join(" | "),
      testAssetMarkers: [...ISOLATED_TEST_MARKERS],
    },
    acceptance: {
      filesGenerated: true,
      bytesCopiedAndHashed: true,
      metadataPublication: false,
      independentAssetVerification: false,
      holderGatedDelivery: false,
      UIRuntime: false,
      atomicBatch: false,
      vault: false,
      fractionalization: false,
      DAO: false,
      marketplace: false,
      wholeProduct: false,
    },
    boundaries: {
      frozenHistoricalRecordsModified: false,
      productionManifestInclusion: false,
      realArtistReferences: false,
      realCchsDocumentsRequired: false,
      realValueTransactionsAuthorized: false,
      newCredentialsOrResources: false,
    },
    sourceDependencies: {},
  };
  // Artificial header-only bytes exercise signature/dimension checks; not decoded PNGs or AI art.
  for (let i = 1; i <= 2; i++) {
    const id = "TESTNET-AI-HOODI-" + String(i).padStart(3, "0"),
      data = Buffer.alloc(34);
    Buffer.from("89504e470d0a1a0a", "hex").copy(data);
    data.writeUInt32BE(13, 8);
    data.write("IHDR", 12);
    data.writeUInt32BE(1024, 16);
    data.writeUInt32BE(1024, 20);
    data[24] = 8;
    data[25] = 2;
    data[33] = i;
    const a = {
      id,
      relativePath: "source-art/" + id + ".png",
      bytes: data.length,
      sha256: sha(data),
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      metadataFile: "metadata/" + id + ".json",
      editionsPerSeries: 100,
      artworkIdBytes32: null,
      artworkIdEncodingStatus:
        "USE_EXISTING_APPROVED_PRODUCER_ENCODING_NOT_ASSUMED",
      holderSpecificDerivativeStatus: "NOT_PREPARED",
      publicMetadataURI: null,
    };
    m.artworks.push(a);
    await writeFile(join(root, a.relativePath), data);
    await writeFile(
      join(root, a.metadataFile),
      JSON.stringify({
        name: id + " isolated AI test series",
        description,
        testAssetMarkers: [...ISOLATED_TEST_MARKERS],
        attributes: [
          { trait_type: "Environment", value: "Hoodi 560048" },
          { trait_type: "Purpose", value: "Isolated technical validation" },
          { trait_type: "Asset ID", value: id },
        ],
        properties: {
          chainId: 560048,
          sourceContentSha256: a.sha256,
          publicArtworkPreview: false,
          publicArtworkUri: null,
          holderPreview: false,
          realWorldValue: false,
          legalEffect: false,
        },
      }),
    );
  }
  const save = () =>
    writeFile(join(root, "input-manifest.json"), JSON.stringify(m));
  const changeMetadata = async (fn) => {
    const path = join(root, m.artworks[0].metadataFile);
    const x = JSON.parse(await readFile(path, "utf8"));
    fn(x);
    await writeFile(path, JSON.stringify(x));
  };
  await save();
  return { root, m, save, changeMetadata };
}
import {
  prepareIsolatedHolderAssets,
  readIsolatedHolderBindingsFile,
} from "../release/lib/isolated-holder-assets.mjs";
async function fixture(t) {
  const f = await baseFixture(t);
  await mkdir(join(f.root, "holder-files"));
  const h = {
    schema: "artfi-private-isolated-holder-input/v1",
    namespace: f.m.namespace,
    chainId: 560048,
    sourceManifestSha256: sha(
      await readFile(join(f.root, "input-manifest.json")),
    ),
    status: "GENERATED_DERIVATIVES_ONLY_NOT_DEPLOYED",
    testAssetMarkers: [...ISOLATED_TEST_MARKERS],
    generation: {
      tool: "built-in image_gen",
      editStartUTC: "2026-10-16T00:00:00Z",
      editEndUTC: "2026-10-16T00:00:01Z",
      pixelExactCopy: false,
      visualReview: "ACTUAL_VISUAL_REVIEW_NOT_MACHINE_PROOF",
    },
    assets: [],
    acceptance: {
      filesGenerated: true,
      byteHashesRecorded: true,
      independentVisualVerification: false,
      ownershipVerified: false,
      published: false,
      holderGatedDelivery: false,
      wholeProduct: false,
    },
    runtimeBindings: null,
  };
  for (const [i, a] of f.m.artworks.entries()) {
    const data = await readFile(join(f.root, a.relativePath));
    data[33] += 10;
    const rel = "holder-files/" + a.id + "-holder.png";
    await writeFile(join(f.root, rel), data);
    h.assets.push({
      id: a.id,
      sourceSha256: a.sha256,
      relativePath: rel,
      bytes: data.length,
      sha256: sha(data),
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      watermark: "TEST HOLDER COPY",
      preview: false,
    });
  }
  const saveHolder = () =>
    writeFile(join(f.root, "holder-input-manifest.json"), JSON.stringify(h));
  const replaceHolder = async (index, data) => {
    const a = h.assets[index];
    await writeFile(join(f.root, a.relativePath), data);
    a.bytes = data.length;
    a.sha256 = sha(data);
    await saveHolder();
  };
  await saveHolder();
  return { ...f, h, saveHolder, replaceHolder };
}
const binding = (f) => ({
  schema: "artfi-isolated-holder-bindings/v1",
  namespace: f.m.namespace,
  chainId: 560048,
  collection: address(20),
  runtimeCodeHash: "0x" + digest(21),
  privateObjectPrefix: "test/" + f.m.namespace + "/holder",
  assets: f.m.artworks.map((a, i) => ({
    id: a.id,
    tokenId: String(100 + i),
    objectKey: "test/" + f.m.namespace + "/holder/" + a.id + "-holder.png",
  })),
});
const prepare = (f, b) =>
  prepareIsolatedHolderAssets(
    f.root,
    b === undefined ? undefined : JSON.stringify(b),
  );
test("validates exact distinct holder inputs while all runtime acceptance stays false", async (t) => {
  const f = await fixture(t),
    r = await prepare(f);
  assert.equal(r.status, "PREPARATION_ONLY");
  assert.equal(r.items.length, 2);
  assert.equal(r.suppliedBindings, null);
  assert.ok(r.missingBindings.length);
  for (const key of [
    "runtimeEnabled",
    "runtimeBindingsObserved",
    "ownershipVerified",
    "objectStoreReadbackVerified",
    "watermarkMachineVerified",
    "imagePixelDecodeVerified",
    "imageGenerationProvenanceVerified",
    "holderGatedDeliveryAccepted",
    "UIAcceptance",
    "wholeProductAccepted",
  ])
    assert.equal(r[key], false);
  assert.equal(r.authorization, "NOT_ESTABLISHED");
  assert.equal(r.items[0].holderSha256, f.h.assets[0].sha256);
});
test("supplied original bindings create exact descriptor candidates without enabling delivery", async (t) => {
  const f = await fixture(t),
    b = binding(f),
    r = await prepare(f, b);
  assert.deepEqual(r.suppliedBindings.candidateDescriptors["100"], {
    class: "watermarked-holder",
    tokenId: "100",
    sha256: f.h.assets[0].sha256,
    masterSha256: f.m.artworks[0].sha256,
    contentType: "image/png",
    byteLength: f.h.assets[0].bytes,
    objectKey: b.assets[0].objectKey,
  });
  assert.equal(r.suppliedBindings.collection, b.collection);
  assert.equal(r.runtimeEnabled, false);
});
test("retains full-width canonical uint256 token identity", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  b.assets[0].tokenId = ((1n << 256n) - 1n).toString();
  const r = await prepare(f, b);
  assert.ok(
    Object.hasOwn(r.suppliedBindings.candidateDescriptors, b.assets[0].tokenId),
  );
});
test("refuses mutable binding objects without invoking their accessors", async (t) => {
  const f = await fixture(t);
  let touched = false;
  const object = {
    get schema() {
      touched = true;
      return "wrong";
    },
  };
  await assert.rejects(
    prepareIsolatedHolderAssets(f.root, object),
    /TEXT_REQUIRED/,
  );
  assert.equal(touched, false);
});
test("refuses duplicate token IDs", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  b.assets[1].tokenId = b.assets[0].tokenId;
  await assert.rejects(prepare(f, b), /ASSET_MISMATCH/);
});
test("refuses duplicate object keys", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  b.assets[1].objectKey = b.assets[0].objectKey;
  await assert.rejects(prepare(f, b), /ASSET_MISMATCH/);
});
test("refuses keys outside the supplied private prefix or with traversal", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  b.assets[0].objectKey = "elsewhere/file.png";
  await assert.rejects(prepare(f, b), /ASSET_MISMATCH/);
  b.assets[0].objectKey = b.privateObjectPrefix + "/../file.png";
  await assert.rejects(prepare(f, b), /ASSET_MISMATCH/);
});
test("refuses frozen collection and incorrect network bindings", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  b.collection = "0xec7d57e6f91fe1d1ee1ec0cb1df8e869088de104";
  await assert.rejects(prepare(f, b), /BINDING_IDENTITY/);
  b.collection = address(20);
  b.chainId = 11155111;
  await assert.rejects(prepare(f, b), /BINDING_IDENTITY/);
});
test("refuses asset-order substitution", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  b.assets.reverse();
  await assert.rejects(prepare(f, b), /ASSET_MISMATCH/);
});
test("refuses noncanonical and overflowing token IDs", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  for (const value of ["0100", "0", 100, (1n << 256n).toString()]) {
    b.assets[0].tokenId = value;
    await assert.rejects(prepare(f, b), /ASSET_MISMATCH/);
  }
});
test("refuses preview properties on either manifest or bindings", async (t) => {
  const f = await fixture(t);
  f.h.assets[0].preview = true;
  await f.saveHolder();
  await assert.rejects(prepare(f), /ASSET_POLICY/);
  f.h.assets[0].preview = false;
  await f.saveHolder();
  const b = binding(f);
  b.assets[0].previewUrl = "https://example.invalid/image.png";
  await assert.rejects(prepare(f, b), /ASSET_FIELDS/);
});
test("refuses changed file bytes and declared sizes", async (t) => {
  const f = await fixture(t);
  f.h.assets[0].sha256 = "1".repeat(64);
  await f.saveHolder();
  await assert.rejects(prepare(f), /CONTENT_MISMATCH/);
  f.h.assets[0].sha256 = sha(
    await readFile(join(f.root, f.h.assets[0].relativePath)),
  );
  f.h.assets[0].bytes++;
  await f.saveHolder();
  await assert.rejects(prepare(f), /CONTENT_MISMATCH/);
});
test("refuses either source master relabelled as a holder file", async (t) => {
  const f = await fixture(t);
  for (const a of f.m.artworks) {
    await f.replaceHolder(0, await readFile(join(f.root, a.relativePath)));
    await assert.rejects(prepare(f), /ASSET_POLICY/);
  }
});
test("refuses duplicate holder content across assets", async (t) => {
  const f = await fixture(t);
  await f.replaceHolder(
    1,
    await readFile(join(f.root, f.h.assets[0].relativePath)),
  );
  await assert.rejects(prepare(f), /ASSET_POLICY/);
});
test("refuses missing or extra holder items", async (t) => {
  const f = await fixture(t);
  f.h.assets.pop();
  await f.saveHolder();
  await assert.rejects(prepare(f), /ASSET_COUNT/);
});
test("refuses namespace and source-manifest substitution", async (t) => {
  const f = await fixture(t);
  f.h.namespace = "TESTNET-AI-HOODI-OTHER";
  await f.saveHolder();
  await assert.rejects(prepare(f), /ISOLATION_INVALID/);
  f.h.namespace = f.m.namespace;
  f.h.sourceManifestSha256 = "1".repeat(64);
  await f.saveHolder();
  await assert.rejects(prepare(f), /ISOLATION_INVALID/);
});
test("refuses claims of ownership or completed delivery", async (t) => {
  const f = await fixture(t);
  f.h.acceptance.ownershipVerified = true;
  await f.saveHolder();
  await assert.rejects(prepare(f), /ACCEPTANCE_CLAIM/);
});
test("refuses malformed PNG header even when the declared hash matches", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(join(f.root, f.h.assets[0].relativePath));
  bytes[0] = 0;
  await f.replaceHolder(0, bytes);
  await assert.rejects(prepare(f), /PNG_HEADER/);
});
test("refuses downscaled or dimension-mismatched files", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(join(f.root, f.h.assets[0].relativePath));
  bytes.writeUInt32BE(512, 16);
  await f.replaceHolder(0, bytes);
  await assert.rejects(prepare(f), /PNG_DIMENSIONS/);
});
test("refuses holder-file symlinks", async (t) => {
  const f = await fixture(t),
    path = join(f.root, f.h.assets[0].relativePath);
  await rm(path);
  await symlink(join(f.root, f.m.artworks[0].relativePath), path);
  await assert.rejects(prepare(f), /SYMLINK_REFUSED/);
});
test("refuses BOM and extra JSON fields in bindings", async (t) => {
  const f = await fixture(t),
    b = binding(f);
  await assert.rejects(
    prepareIsolatedHolderAssets(f.root, "\ufeff" + JSON.stringify(b)),
    /JSON_BOM/,
  );
  b.credentials = "must not be accepted";
  await assert.rejects(prepare(f, b), /BINDING_FIELDS/);
});
test("reads only a bounded regular bindings file and refuses its symlink", async (t) => {
  const f = await fixture(t),
    path = join(f.root, "bindings.json");
  await writeFile(path, JSON.stringify(binding(f)));
  assert.equal(
    await readIsolatedHolderBindingsFile(path),
    JSON.stringify(binding(f)),
  );
  const link = join(f.root, "bindings-link.json");
  await symlink(path, link);
  await assert.rejects(readIsolatedHolderBindingsFile(link), /SYMLINK_REFUSED/);
});
test("refuses unrecognized holder manifest fields", async (t) => {
  const f = await fixture(t);
  f.h.publicURL = "https://example.invalid/image.png";
  await f.saveHolder();
  await assert.rejects(prepare(f), /MANIFEST_FIELDS/);
});
test("retains the original metadata no-preview gate", async (t) => {
  const f = await fixture(t);
  await f.changeMetadata((m) => {
    m.image = "https://example.invalid/master.png";
  });
  await assert.rejects(prepare(f), /METADATA_FIELDS_INVALID/);
});
