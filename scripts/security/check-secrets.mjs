import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.endsWith("pnpm-lock.yaml"));

const rules = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[ps]_[A-Za-z0-9]{30,}\b/],
  [
    "raw EVM private key assignment",
    /(?:PRIVATE_KEY|SECRET_KEY)\s*=\s*0x[0-9a-fA-F]{64}\b/,
  ],
  [
    "mnemonic assignment",
    /(?:MNEMONIC|SEED_PHRASE)\s*=\s*["'][a-z]+(?:\s+[a-z]+){11,23}["']/i,
  ],
];

const findings = [];
for (const file of files) {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [name, pattern] of rules) {
    if (pattern.test(contents)) findings.push(`${file}: ${name}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Potential committed secrets detected:\n${findings.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Secret pattern check passed across ${files.length} repository files.\n`,
);
