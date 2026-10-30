import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  FIRST_CHARITY_TRANCHE_ARTWORK_IDS,
  selectFirstCharityTranche,
} from "./charity-first-tranche.mjs";

const wallet = `0x${"12".repeat(20)}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const serialize = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

function fixture(chainId = 560048) {
  const packages = new Map();
  const ids = [
    "UNIT-A01",
    ...Array.from(
      { length: 36 },
      (_, i) => `UNIT-A${String(i + 3).padStart(2, "0")}`,
    ),
  ];
  const records = ids.map((artworkId) => {
    const metadataURI = `https://io.artcch.com/nft/metadata/${chainId === 560048 ? "hoodi" : "sepolia"}/ye-yongrun/${artworkId}.json`;
    const masterSha256 = hash(artworkId);
    const packageFile = `${artworkId}.charity-edition.json`;
    const manifest = {
      schemaVersion: 1,
      chainId,
      standard: "ERC-1155",
      series: {
        artworkId,
        editions: 100,
        immutableSupply: true,
        distributionWallet: wallet,
        unitPriceWei: "10000000000000000",
        currency: "ETH",
      },
      artwork: {
        masterSha256,
        publicArtworkPreview: false,
        publicArtworkUri: null,
        unwatermarkedWebDownload: false,
      },
      metadata: { publicURI: metadataURI },
      holderAsset: {
        preview: false,
        publicUri: null,
        unwatermarkedAvailable: false,
        watermarked: true,
        delivery: "token-gated-download",
      },
      rights: { listingActionConfirmed: false },
    };
    const originalBytes = serialize(manifest);
    packages.set(packageFile, originalBytes);
    return {
      artworkId,
      packageFile,
      packageSha256: hash(originalBytes),
      masterFile: `${artworkId}-000.png`,
      masterSha256,
      metadataURI,
      editions: 100,
      distributionWallet: wallet,
    };
  });
  const index = {
    schemaVersion: 1,
    batchId: "ye-yongrun-unit-a01-a38",
    status: "blocked-pre-mint",
    chainId,
    standard: "ERC-1155",
    packageCount: 37,
    totalUnits: 3700,
    initialRecipient: wallet,
    packages: records,
  };
  const reads = [];
  return {
    index,
    packages,
    reads,
    run: () =>
      selectFirstCharityTranche({
        indexBytes: serialize(index),
        readPackage: (name) => {
          reads.push(name);
          return packages.get(name);
        },
      }),
    changePackage: (edit) => {
      const record = records[0];
      const manifest = JSON.parse(packages.get(record.packageFile));
      edit(manifest);
      const nextBytes = serialize(manifest);
      packages.set(record.packageFile, nextBytes);
      record.packageSha256 = hash(nextBytes);
    },
  };
}

test("selects exactly 13 unique works and 1300 units without changing the formal set", () => {
  const f = fixture();
  const before = serialize(f.index);
  const result = f.run();
  assert.deepEqual(
    result.packages.map((p) => p.artworkId),
    FIRST_CHARITY_TRANCHE_ARTWORK_IDS,
  );
  assert.equal(new Set(result.packages.map((p) => p.artworkId)).size, 13);
  assert.equal(
    result.packages.filter((p) => p.artworkId === "UNIT-A16").length,
    1,
  );
  assert.equal(result.packageCount, 13);
  assert.equal(result.totalUnits, 1300);
  assert.equal(result.sourceIndexSha256, hash(before));
  assert.equal(f.reads.length, 13);
  assert.deepEqual(serialize(f.index), before);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.status, "selection-only");
  assert.equal(result.releaseEligibility, "not-evaluated");
  assert.equal(result.onChainState, "not-evaluated");
  assert.throws(() => {
    result.packages[0].editions = 101;
  }, TypeError);
  assert.throws(() => {
    result.packages.push({});
  }, TypeError);
});

test("preserves historical chain and metadata references without generating a new mint batch", () => {
  const result = fixture(11155111).run();
  assert.equal(result.chainId, 11155111);
  assert.match(result.packages[0].metadataURI, /\/sepolia\//);
});

const invalidIndexes = [
  [
    "duplicate artwork",
    (i) => {
      i.packages[1] = { ...i.packages[0] };
    },
  ],
  [
    "withdrawn artwork",
    (i) => {
      i.packages[1].artworkId = "UNIT-A02";
    },
  ],
  [
    "missing record",
    (i) => {
      i.packages.pop();
    },
  ],
  [
    "wrong supply",
    (i) => {
      i.packages[0].editions = 101;
    },
  ],
  [
    "duplicate master",
    (i) => {
      i.packages[1].masterSha256 = i.packages[0].masterSha256;
    },
  ],
  [
    "unsafe filename",
    (i) => {
      i.packages[0].packageFile = "../outside.json";
    },
  ],
  [
    "wrong network",
    (i) => {
      i.chainId = 1;
    },
  ],
  [
    "cross-chain URI",
    (i) => {
      i.packages[0].metadataURI = i.packages[0].metadataURI.replace(
        "hoodi",
        "sepolia",
      );
    },
  ],
  [
    "zero recipient",
    (i) => {
      i.initialRecipient = `0x${"0".repeat(40)}`;
    },
  ],
  [
    "upgraded index status",
    (i) => {
      i.status = "ready-to-mint";
    },
  ],
];
for (const [name, edit] of invalidIndexes) {
  test(`rejects ${name} before reading package files`, () => {
    const f = fixture();
    edit(f.index);
    assert.throws(f.run);
    assert.equal(f.reads.length, 0);
  });
}

test("requires original package bytes, including whitespace", () => {
  const f = fixture();
  const key = f.index.packages[0].packageFile;
  f.packages.set(key, Buffer.concat([f.packages.get(key), Buffer.from(" ")]));
  assert.throws(f.run, /package byte hash differs/);
});

for (const [name, edit] of [
  [
    "package chain mismatch",
    (m) => {
      m.chainId = 11155111;
    },
  ],
  [
    "mutable supply",
    (m) => {
      m.series.immutableSupply = false;
    },
  ],
  [
    "series mismatch",
    (m) => {
      m.series.artworkId = "UNIT-A03";
    },
  ],
  [
    "master hash mismatch",
    (m) => {
      m.artwork.masterSha256 = hash("different");
    },
  ],
  [
    "master preview",
    (m) => {
      m.artwork.publicArtworkPreview = true;
    },
  ],
  [
    "public holder file",
    (m) => {
      m.holderAsset.publicUri = "https://example.invalid/file";
    },
  ],
  [
    "preconfirmed listing",
    (m) => {
      m.rights.listingActionConfirmed = true;
    },
  ],
]) {
  test(`rejects ${name} even when package hash is rebound`, () => {
    const f = fixture();
    f.changePackage(edit);
    assert.throws(f.run);
  });
}

test("rejects malformed original bytes without disclosing source content", () => {
  assert.throws(
    () =>
      selectFirstCharityTranche({
        indexBytes: Buffer.from([0xff]),
        readPackage() {},
      }),
    /invalid UTF-8 JSON/,
  );
  assert.throws(
    () => selectFirstCharityTranche({ indexBytes: "{}", readPackage() {} }),
    /original bytes are required/,
  );
});
