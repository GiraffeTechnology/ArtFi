import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Preserve the original native Agent source layout in a fresh bundle only.
export async function bundleAgentSources(root, bundle) {
  await mkdir(join(bundle, "scripts"), { recursive: true });
  const agent = join(bundle, "scripts/agent");
  await cp(join(root, "scripts/agent"), agent, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await cp(
    join(root, "scripts/native-nft-currency.mjs"),
    join(bundle, "scripts/native-nft-currency.mjs"),
    { errorOnExist: true, force: false },
  );
}
