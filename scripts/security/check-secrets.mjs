import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findSecretPatterns } from "./secret-patterns.mjs";

const files = execFileSync("git", ["ls-files", "-coz", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .filter((file) => !file.endsWith("pnpm-lock.yaml"));

const findings = [];
for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file);
  } catch {
    continue;
  }
  for (const name of findSecretPatterns(contents)) {
    findings.push(JSON.stringify(file) + ": " + name);
  }
}
if (findings.length > 0) {
  process.stderr.write(
    "Potential committed secrets detected:\n" + findings.join("\n") + "\n",
  );
  process.exit(1);
}
process.stdout.write(
  "Secret pattern check passed across " + files.length + " repository files.\n",
);
