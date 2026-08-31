import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [
  preflight,
  deploy,
  deploySafeShell,
  stage2,
  stage3,
  charity,
  safeDeploy,
  policy,
  manifest,
  schema,
] = await Promise.all([
  readFile(new URL("./hoodi-admin-safe-preflight.sh", import.meta.url), "utf8"),
  readFile(new URL("./hoodi-admin-safe-deploy.sh", import.meta.url), "utf8"),
  readFile(new URL("./hoodi-deploy-admin-safe.sh", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../../packages/contracts/script/DeployStage2.s.sol",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../../packages/contracts/script/DeployStage3.s.sol",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../../packages/contracts/script/DeployCharityEditions.s.sol",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../../packages/contracts/script/DeployAdminSafe.s.sol",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../../packages/contracts/src/AdminSafeDeploymentPolicy.sol",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../../release/hoodi-admin-safe-deployment.example.json",
      import.meta.url,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "../../release/hoodi-admin-safe-deployment.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
]);

assert.match(preflight, /560048/, "Hoodi preflight must pin chain ID 560048");
assert.match(
  preflight,
  /ARTFI_ADMIN_SAFE_CODEHASH/,
  "preflight must pin runtime code",
);
assert.match(preflight, /owners\(\)/, "preflight must attest the owner set");
assert.match(preflight, /threshold\(\)/, "preflight must attest the threshold");
assert.match(preflight, /delaySeconds\(\)/, "preflight must attest the delay");
assert.match(
  deploy,
  /hoodi-admin-safe-preflight\.sh/,
  "deploy must call the Hoodi preflight",
);
assert.match(
  deploySafeShell,
  /DeployAdminSafe\.s\.sol:DeployAdminSafe/,
  "safe deployment must use the fixed script",
);
assert.match(deploySafeShell, /560048/, "safe deployment must pin Hoodi");
assert.match(
  safeDeploy,
  /ARTFI_ADMIN_SAFE_OWNERS/,
  "safe deployment must receive the owner set",
);
assert.match(
  policy,
  /DuplicateAdminSafeOwner/,
  "shared policy must reject duplicate owners",
);
for (const [name, script] of [
  ["stage2", stage2],
  ["stage3", stage3],
  ["charity", charity],
]) {
  assert.match(
    script,
    /ARTFI_ADMIN_SAFE/,
    `${name} must use the consolidated safe`,
  );
  assert.match(
    script,
    /AdminSafeDeploymentPolicy\.validate/,
    `${name} must validate the safe`,
  );
  assert.doesNotMatch(
    script,
    /envAddress\("ARTFI_(?:ADMIN|PAUSER|REGISTRAR|VAULT_CREATOR|EDITION_CREATOR|DONATION_RECORDER)"\)/,
    `${name} must not use an EOA final-role input`,
  );
}
assert.equal(
  JSON.parse(manifest).chainId,
  560048,
  "new manifest must be Hoodi-only",
);
const parsedManifest = JSON.parse(manifest);
const parsedSchema = JSON.parse(schema);
assert.deepEqual(
  Object.keys(parsedManifest.stages.stage2.roleHolders).sort(),
  [
    "registryAdmin",
    "registryPauser",
    "registryRegistrar",
    "rwaAdmin",
    "rwaPauser",
  ],
  "stage2 manifest must enumerate its exact role inventory",
);
assert.deepEqual(
  Object.keys(parsedManifest.stages.stage3.roleHolders).sort(),
  ["factoryAdmin", "factoryCreator", "factoryPauser"],
  "stage3 manifest must enumerate its exact role inventory",
);
assert.deepEqual(
  Object.keys(parsedManifest.stages.charity.roleHolders).sort(),
  [
    "charityAdmin",
    "charityDonationRecorder",
    "charityPauser",
    "charitySeriesCreator",
  ],
  "charity manifest must enumerate its exact role inventory",
);
assert.equal(
  parsedManifest.treasuryAuthority.status,
  "not-applicable",
  "manifest must not imply an unimplemented treasury surface",
);
assert.equal(
  parsedSchema.additionalProperties,
  false,
  "schema top level must reject extra keys",
);
for (const [stageName, roles] of Object.entries({
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
})) {
  const stageSchema = parsedSchema.$defs[stageName];
  assert.equal(
    stageSchema.additionalProperties,
    false,
    `${stageName} schema must reject extras`,
  );
  assert.equal(
    stageSchema.properties.roleHolders.additionalProperties,
    false,
    `${stageName} role inventory must reject extras`,
  );
  assert.deepEqual(
    [...stageSchema.properties.roleHolders.required].sort(),
    [...roles].sort(),
    `${stageName} schema required roles must match verifier inventory`,
  );
}
process.stdout.write("hoodi-admin-safe-tooling=pass\n");
