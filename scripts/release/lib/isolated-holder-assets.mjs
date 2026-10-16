import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ISOLATED_TEST_MARKERS,
  prepareIsolatedHoodiCharity,
} from "./isolated-hoodi-payload.mjs";

const HASH = /^[a-f0-9]{64}$/;
const FROZEN = "0xec7d57e6f91fe1d1ee1ec0cb1df8e869088de104";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function check(value, code) {
  if (!value) throw Error(code);
}
function keys(value, expected, code) {
  check(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") === [...expected].sort().join("\0"),
    code,
  );
}
function markers(value) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    ISOLATED_TEST_MARKERS.every((m) => value.includes(m))
  );
}
function json(bytes) {
  check(
    !bytes.subarray(0, 3).equals(Buffer.from("efbbbf", "hex")),
    "HOLDER_JSON_BOM",
  );
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
async function physical(path) {
  const p = resolve(path);
  for (let at = p; ; at = dirname(at)) {
    check(!(await lstat(at)).isSymbolicLink(), "HOLDER_SYMLINK_REFUSED");
    if (dirname(at) === at) break;
  }
  return p;
}
async function read(directory, name, maximum) {
  const root = await physical(directory);
  check((await lstat(root)).isDirectory(), "HOLDER_ROOT_INVALID");
  check(
    typeof name === "string" &&
      /^[A-Za-z0-9_./-]+$/.test(name) &&
      !isAbsolute(name) &&
      !name.split("/").some((p) => !p || p === "." || p === ".."),
    "HOLDER_PATH_INVALID",
  );
  const path = await physical(join(root, name)),
    part = relative(root, path);
  check(
    part !== "" &&
      !isAbsolute(part) &&
      part !== ".." &&
      !part.startsWith(".." + sep) &&
      (await realpath(path)) === path,
    "HOLDER_PATH_ESCAPE",
  );
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await fd.stat();
    check(
      before.isFile() && before.size > 0 && before.size <= maximum,
      "HOLDER_FILE_SIZE",
    );
    const bytes = await fd.readFile(),
      after = await fd.stat(),
      current = await lstat(path);
    check(
      bytes.length === before.size &&
        [after, current].every(
          (s) =>
            s.isFile() &&
            s.dev === before.dev &&
            s.ino === before.ino &&
            s.size === before.size &&
            s.mtimeMs === before.mtimeMs &&
            s.ctimeMs === before.ctimeMs,
        ),
      "HOLDER_FILE_CHANGED",
    );
    await physical(path);
    check((await realpath(path)) === path, "HOLDER_PATH_ESCAPE");
    return { bytes, size: bytes.length, sha256: hash(bytes) };
  } finally {
    await fd.close();
  }
}
export async function readIsolatedHolderBindingsFile(path) {
  const absolute = resolve(path);
  const value = await read(dirname(absolute), basename(absolute), 65536);
  json(value.bytes); // Reject malformed UTF-8, BOM and malformed JSON before returning immutable text.
  return new TextDecoder("utf-8", { fatal: true }).decode(value.bytes);
}
function validateManifest(m, source) {
  keys(
    m,
    [
      "schema",
      "namespace",
      "chainId",
      "sourceManifestSha256",
      "status",
      "testAssetMarkers",
      "generation",
      "assets",
      "acceptance",
      "runtimeBindings",
    ],
    "HOLDER_MANIFEST_FIELDS",
  );
  check(
    m.schema === "artfi-private-isolated-holder-input/v1" &&
      m.namespace === source.namespace &&
      m.chainId === 560048 &&
      m.sourceManifestSha256 === source.inputManifestSha256 &&
      m.status === "GENERATED_DERIVATIVES_ONLY_NOT_DEPLOYED" &&
      markers(m.testAssetMarkers) &&
      m.runtimeBindings === null,
    "HOLDER_ISOLATION_INVALID",
  );
  keys(
    m.generation,
    ["tool", "editStartUTC", "editEndUTC", "pixelExactCopy", "visualReview"],
    "HOLDER_GENERATION_FIELDS",
  );
  const utc = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  check(
    m.generation.tool === "built-in image_gen" &&
      utc(m.generation.editStartUTC) &&
      utc(m.generation.editEndUTC) &&
      Date.parse(m.generation.editEndUTC) >=
        Date.parse(m.generation.editStartUTC) &&
      m.generation.pixelExactCopy === false &&
      m.generation.visualReview === "ACTUAL_VISUAL_REVIEW_NOT_MACHINE_PROOF",
    "HOLDER_GENERATION_INVALID",
  );
  keys(
    m.acceptance,
    [
      "filesGenerated",
      "byteHashesRecorded",
      "independentVisualVerification",
      "ownershipVerified",
      "published",
      "holderGatedDelivery",
      "wholeProduct",
    ],
    "HOLDER_ACCEPTANCE_FIELDS",
  );
  check(
    m.acceptance.filesGenerated === true &&
      m.acceptance.byteHashesRecorded === true &&
      Object.entries(m.acceptance).every(
        ([k, v]) =>
          ["filesGenerated", "byteHashesRecorded"].includes(k) || v === false,
      ),
    "HOLDER_ACCEPTANCE_CLAIM",
  );
  check(
    Array.isArray(m.assets) && m.assets.length === source.items.length,
    "HOLDER_ASSET_COUNT",
  );
}
function png(bytes, item, original) {
  check(
    bytes.length >= 33 &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      bytes.readUInt32BE(8) === 13 &&
      bytes.subarray(12, 16).toString("ascii") === "IHDR",
    "HOLDER_PNG_HEADER",
  );
  check(
    bytes.readUInt32BE(16) === item.width &&
      bytes.readUInt32BE(20) === item.height &&
      item.width === original.width &&
      item.height === original.height &&
      item.width >= 512 &&
      item.height >= 512 &&
      item.width <= 8192 &&
      item.height <= 8192 &&
      item.width * item.height <= 16777216 &&
      [1, 2, 4, 8, 16].includes(bytes[24]) &&
      [0, 2, 3, 4, 6].includes(bytes[25]) &&
      bytes[26] === 0 &&
      bytes[27] === 0 &&
      [0, 1].includes(bytes[28]),
    "HOLDER_PNG_DIMENSIONS",
  );
  // This checks a PNG header only, not pixels, alpha, CRCs or semantic watermark visibility.
}
function privateKey(value) {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^[A-Za-z0-9_./-]+$/.test(value) &&
    value.split("/").every((p) => p && p !== "." && p !== "..") &&
    !/UNIT-A|ye-yongrun/i.test(value)
  );
}
function bindings(text, namespace, items) {
  const b = json(Buffer.from(text, "utf8"));
  keys(
    b,
    [
      "schema",
      "namespace",
      "chainId",
      "collection",
      "runtimeCodeHash",
      "privateObjectPrefix",
      "assets",
    ],
    "HOLDER_BINDING_FIELDS",
  );
  check(
    b.schema === "artfi-isolated-holder-bindings/v1" &&
      b.namespace === namespace &&
      b.chainId === 560048 &&
      typeof b.collection === "string" &&
      /^0x[0-9a-fA-F]{40}$/.test(b.collection) &&
      !/^0x0+$/i.test(b.collection) &&
      b.collection.toLowerCase() !== FROZEN &&
      typeof b.runtimeCodeHash === "string" &&
      /^0x[0-9a-fA-F]{64}$/.test(b.runtimeCodeHash) &&
      !/^0x0+$/i.test(b.runtimeCodeHash) &&
      privateKey(b.privateObjectPrefix) &&
      b.privateObjectPrefix.split("/").includes(namespace),
    "HOLDER_BINDING_IDENTITY",
  );
  check(
    Array.isArray(b.assets) && b.assets.length === items.length,
    "HOLDER_BINDING_COUNT",
  );
  const tokens = new Set(),
    objects = new Set(),
    candidates = {};
  b.assets.forEach((a, i) => {
    keys(a, ["id", "tokenId", "objectKey"], "HOLDER_BINDING_ASSET_FIELDS");
    check(
      a.id === items[i].id &&
        typeof a.tokenId === "string" &&
        /^[1-9][0-9]{0,77}$/.test(a.tokenId) &&
        BigInt(a.tokenId) <= (1n << 256n) - 1n &&
        !tokens.has(a.tokenId) &&
        privateKey(a.objectKey) &&
        a.objectKey.startsWith(b.privateObjectPrefix + "/") &&
        !objects.has(a.objectKey),
      "HOLDER_BINDING_ASSET_MISMATCH",
    );
    tokens.add(a.tokenId);
    objects.add(a.objectKey);
    candidates[a.tokenId] = {
      class: "watermarked-holder",
      tokenId: a.tokenId,
      sha256: items[i].holderSha256,
      masterSha256: items[i].masterSha256,
      contentType: "image/png",
      byteLength: items[i].holderBytes,
      objectKey: a.objectKey,
    };
  });
  return {
    chainId: 560048,
    collection: b.collection,
    runtimeCodeHash: b.runtimeCodeHash,
    privateObjectPrefix: b.privateObjectPrefix,
    candidateDescriptors: candidates,
  };
}

/** Private local preparation only. Bindings text is copied/parsed before any await; no live authority. */
export async function prepareIsolatedHolderAssets(directory, bindingsJSON) {
  check(
    bindingsJSON === undefined ||
      (typeof bindingsJSON === "string" &&
        Buffer.byteLength(bindingsJSON) <= 65536),
    "HOLDER_BINDINGS_TEXT_REQUIRED",
  );
  const fixedBindings = bindingsJSON;
  const source = await prepareIsolatedHoodiCharity(directory);
  const manifestFile = await read(
    directory,
    "holder-input-manifest.json",
    65536,
  );
  const manifest = json(manifestFile.bytes);
  validateManifest(manifest, source);
  const sourceHashes = new Set(source.items.map((a) => a.masterSha256)),
    holderHashes = new Set(),
    items = [];
  for (let i = 0; i < manifest.assets.length; i++) {
    const a = manifest.assets[i],
      original = source.items[i];
    keys(
      a,
      [
        "id",
        "sourceSha256",
        "relativePath",
        "bytes",
        "sha256",
        "mimeType",
        "width",
        "height",
        "watermark",
        "preview",
      ],
      "HOLDER_ASSET_FIELDS",
    );
    check(
      a.id === original.id &&
        a.sourceSha256 === original.masterSha256 &&
        a.relativePath === "holder-files/" + a.id + "-holder.png" &&
        Number.isSafeInteger(a.bytes) &&
        a.bytes > 0 &&
        a.bytes <= 10485760 &&
        typeof a.sha256 === "string" &&
        HASH.test(a.sha256) &&
        !sourceHashes.has(a.sha256) &&
        !holderHashes.has(a.sha256) &&
        a.mimeType === "image/png" &&
        Number.isSafeInteger(a.width) &&
        Number.isSafeInteger(a.height) &&
        a.watermark === "TEST HOLDER COPY" &&
        a.preview === false,
      "HOLDER_ASSET_POLICY",
    );
    const file = await read(directory, a.relativePath, 10485760);
    check(
      file.size === a.bytes && file.sha256 === a.sha256,
      "HOLDER_CONTENT_MISMATCH",
    );
    png(file.bytes, a, original);
    holderHashes.add(a.sha256);
    items.push({
      id: a.id,
      masterSha256: original.masterSha256,
      holderFile: a.relativePath,
      holderSha256: file.sha256,
      holderBytes: file.size,
      width: a.width,
      height: a.height,
      metadataSha256: original.metadataSha256,
    });
  }
  const supplied =
    fixedBindings === undefined
      ? null
      : bindings(fixedBindings, source.namespace, items);
  const after = await prepareIsolatedHoodiCharity(directory);
  check(
    after.inputManifestSha256 === source.inputManifestSha256 &&
      JSON.stringify(after.items) === JSON.stringify(source.items) &&
      (await read(directory, "holder-input-manifest.json", 65536)).sha256 ===
        manifestFile.sha256,
    "HOLDER_INPUT_CHANGED",
  );
  for (const item of items)
    check(
      (await read(directory, item.holderFile, 10485760)).sha256 ===
        item.holderSha256,
      "HOLDER_INPUT_CHANGED",
    );
  return {
    schema: "artfi-isolated-holder-preparation/v1",
    status: "PREPARATION_ONLY",
    chainId: 560048,
    namespace: source.namespace,
    testAssetMarkers: [...ISOLATED_TEST_MARKERS],
    sourceManifestSha256: source.inputManifestSha256,
    holderManifestSha256: manifestFile.sha256,
    items,
    suppliedBindings: supplied,
    missingBindings: supplied
      ? []
      : [
          "original approved collection and observed runtime identity",
          "actual token IDs for the isolated collection",
          "original private holder-store prefix/object keys and verified uploaded bytes",
        ],
    runtimeEnabled: false,
    authorization: "NOT_ESTABLISHED",
    runtimeBindingsObserved: false,
    ownershipVerified: false,
    objectStoreReadbackVerified: false,
    watermarkMachineVerified: false,
    imagePixelDecodeVerified: false,
    imageGenerationProvenanceVerified: false,
    holderGatedDeliveryAccepted: false,
    UIAcceptance: false,
    wholeProductAccepted: false,
  };
}
