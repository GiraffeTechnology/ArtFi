import { readFileSync } from "node:fs";

const [path] = process.argv.slice(2);
if (!path) {
  throw new Error(
    "usage: verify-hoodi-admin-safe-deployment.mjs <manifest.json>",
  );
}
const manifest = JSON.parse(readFileSync(path, "utf8"));
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const hashPattern = /^[0-9a-f]{64}$/;

function requireExactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${name} keys must be exactly: ${wanted.join(",")}`);
  }
}

const stageRoleKeys = {
  stage2: [
    "registryAdmin",
    "registryRegistrar",
    "registryPauser",
    "rwaAdmin",
    "rwaPauser",
  ],
  stage3: ["factoryAdmin", "factoryCreator", "factoryPauser"],
  charity: [
    "charityAdmin",
    "charitySeriesCreator",
    "charityDonationRecorder",
    "charityPauser",
  ],
};

requireExactKeys(
  manifest,
  [
    "schema",
    "chainId",
    "safeId",
    "adminSafe",
    "stages",
    "treasuryAuthority",
    "nftTreasuryCustodyClaimed",
    "testAssetMarkers",
  ],
  "manifest",
);

if (
  manifest.schema !== "artfi-hoodi-admin-safe-deployment/v1" ||
  manifest.chainId !== 560048
) {
  throw new Error("manifest must use the Hoodi admin-safe deployment schema");
}

/**
 * `PRD.md` §7.0's second place for the test-asset markers: contract or series level at deployment.
 *
 * This record is the deployment. Everything it describes lives on Hoodi -- the schema and chain id
 * above admit nothing else -- so it is a test deployment and says so in the words §7.0 fixes. The
 * markers were carried in token metadata, on screen and in the batch manifest but not here, which
 * left three of four filled; §7.0 requires all four.
 */
const requiredTestAssetMarkers = [
  "TESTNET",
  "NO REAL-WORLD VALUE",
  "NO LEGAL EFFECT",
];
if (
  !Array.isArray(manifest.testAssetMarkers) ||
  requiredTestAssetMarkers.some(
    (marker) => !manifest.testAssetMarkers.includes(marker),
  )
) {
  throw new Error(
    `testAssetMarkers must contain ${requiredTestAssetMarkers.join(", ")} (PRD.md §7.0)`,
  );
}
const safe = manifest.adminSafe;
requireExactKeys(
  safe,
  [
    "address",
    "runtimeCodehash",
    "ownersSha256",
    "ownerCount",
    "threshold",
    "delaySeconds",
  ],
  "adminSafe",
);
if (
  !addressPattern.test(safe?.address) ||
  safe.address === "0x0000000000000000000000000000000000000000" ||
  !hashPattern.test(safe.runtimeCodehash) ||
  !hashPattern.test(safe.ownersSha256) ||
  !Number.isInteger(safe.ownerCount) ||
  safe.ownerCount < 2 ||
  !Number.isInteger(safe.threshold) ||
  safe.threshold < 2 ||
  safe.threshold > safe.ownerCount ||
  !Number.isInteger(safe.delaySeconds) ||
  safe.delaySeconds <= 0
) {
  throw new Error(
    "admin safe identity or owner/threshold/delay policy is invalid",
  );
}
const expectedSafeId = `hoodi-560048-${safe.address.toLowerCase()}-${safe.runtimeCodehash.toLowerCase()}`;
if (manifest.safeId !== expectedSafeId) {
  throw new Error(
    "safeId must canonically bind chain, safe address, and runtime code hash",
  );
}

const stages = manifest.stages;
requireExactKeys(stages, ["stage2", "stage3", "charity"], "stages");
for (const stageName of ["stage2", "stage3", "charity"]) {
  const stage = stages?.[stageName];
  const stageKeys = {
    stage2: [
      "safeId",
      "bootstrapDeployerRolesRevoked",
      "roleHolders",
      "rwaMinterHolder",
    ],
    stage3: ["safeId", "roleHolders", "futureVaultRoleBinding"],
    charity: ["enabled", "safeId", "roleHolders"],
  };
  requireExactKeys(stage, stageKeys[stageName], stageName);
  if (!stage || stage.safeId !== manifest.safeId) {
    throw new Error(`${stageName} must bind the consolidated safeId`);
  }
  requireExactKeys(
    stage.roleHolders,
    stageRoleKeys[stageName],
    `${stageName}.roleHolders`,
  );
  for (const [role, holder] of Object.entries(stage.roleHolders)) {
    if (!addressPattern.test(holder)) {
      throw new Error(`${stageName}.${role} must be a valid address`);
    }
    if (holder.toLowerCase() !== safe.address.toLowerCase()) {
      throw new Error(`${stageName}.${role} must be held by the admin safe`);
    }
  }
}
if (stages.stage2.bootstrapDeployerRolesRevoked !== true) {
  throw new Error(
    "stage2 must attest complete bootstrap deployer role revocation",
  );
}
if (stages.stage2.rwaMinterHolder !== "registry") {
  throw new Error("the RWA minter role must be held only by the registry");
}
if (
  stages.stage3.futureVaultRoleBinding !==
  "controlled-action-must-bind-admin-safe"
) {
  throw new Error(
    "future child-vault role arguments need a separate safe-bound action gate",
  );
}
if (manifest.nftTreasuryCustodyClaimed !== false) {
  throw new Error(
    "this milestone must not claim ERC-721/ERC-1155 treasury custody",
  );
}
requireExactKeys(
  manifest.treasuryAuthority,
  ["status", "rationale"],
  "treasuryAuthority",
);
if (
  manifest.treasuryAuthority.status !== "not-applicable" ||
  typeof manifest.treasuryAuthority.rationale !== "string" ||
  manifest.treasuryAuthority.rationale.length === 0
) {
  throw new Error(
    "treasury authority must be explicitly not-applicable with a rationale",
  );
}

process.stdout.write("hoodi-admin-safe-manifest=pass\n");
