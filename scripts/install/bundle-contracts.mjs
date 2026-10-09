import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

/** Export only freshly built application contracts, never test/script contracts or bindings. */
export async function bundleContracts(root, destination, sourceFingerprint) {
  const output = join(root, "packages/contracts/out");
  const { keccak256 } = createRequire(
    join(root, "apps/agent-runtime/package.json"),
  )("ethers");
  const checkedSources = new Map();
  const contracts = [];
  for (const folder of await readdir(output, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name === "build-info") continue;
    for (const filename of await readdir(join(output, folder.name))) {
      if (!filename.endsWith(".json")) continue;
      const file = join(output, folder.name, filename),
        artifact = JSON.parse(await readFile(file, "utf8"));
      const target = artifact.metadata?.settings?.compilationTarget;
      if (!target || Object.keys(target).length !== 1) continue;
      const [source] = Object.keys(target),
        name = target[source];
      if (
        !/^src\/[A-Za-z0-9_./-]+\.sol$/.test(source) ||
        source.includes("..") ||
        !Array.isArray(artifact.abi)
      )
        continue;
      for (const [input, metadata] of Object.entries(
        artifact.metadata.sources || {},
      )) {
        if (
          !/^(?:src|node_modules)\/[A-Za-z0-9_@./-]+\.sol$/.test(input) ||
          input.includes("..")
        )
          throw new Error("Unexpected contract artifact source path.");
        if (!checkedSources.has(input))
          checkedSources.set(
            input,
            keccak256(await readFile(join(root, "packages/contracts", input))),
          );
        if (checkedSources.get(input) !== metadata.keccak256)
          throw new Error(
            "Contract artifact does not match current application/dependency source.",
          );
      }
      if (!String(artifact.metadata?.compiler?.version).startsWith("0.8.30+"))
        throw new Error(
          "Contract artifact uses an unexpected Solidity compiler.",
        );
      const relative = join(source.replace(/^src\//, ""), `${name}.json`);
      await mkdir(join(destination, source.replace(/^src\//, "")), {
        recursive: true,
      });
      await cp(file, join(destination, relative));
      contracts.push({
        name,
        source,
        artifact: relative,
        compiler: artifact.metadata.compiler.version,
        deployable: Boolean(
          artifact.bytecode?.object && artifact.bytecode.object !== "0x",
        ),
        constructor:
          artifact.abi.find((x) => x.type === "constructor")?.inputs || [],
        requiresLibraryLinking:
          Object.keys(artifact.bytecode?.linkReferences || {}).length > 0,
      });
    }
  }
  if (
    !contracts.some((c) => c.name === "RWARegistry") ||
    !contracts.some((c) => c.name === "ArtFiMarket") ||
    !contracts.some((c) => c.name === "WholeArtworkMarket") ||
    !contracts.some((c) => c.name === "ArtFiAdminSafe")
  )
    throw new Error("Required application contract artifacts are missing.");
  contracts.sort(
    (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
  );
  await writeFile(
    join(destination, "inventory.json"),
    JSON.stringify(
      {
        format: 1,
        sourceFingerprint,
        compiler: "0.8.30",
        scope:
          "Application ABI and bytecode only; no deployment, chain selection, addresses, keys or execution authority.",
        contracts,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(destination, "README.txt"),
    "Precompiled application ABI and bytecode from this release source. Test contracts and deployment bindings are excluded. Review constructor inputs and library-linking requirements in inventory.json. These files do not select a production chain, grant transaction authority, supply roles or source approvals, or deploy a contract. Operators must use their authorized wallet/deployment process and independently verify deployed code and constructor bindings. No onsite compilation is needed to consume these artifacts.\n",
  );
  return contracts;
}
