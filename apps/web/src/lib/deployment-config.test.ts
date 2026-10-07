import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "../app/api/health/route";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(webRoot, "src");
const dockerfile = readFileSync(path.join(webRoot, "Dockerfile"), "utf8");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(filename);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [readFileSync(filename, "utf8")]
      : [];
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("deployment configuration", () => {
  it("can embed every public setting the web app actually reads", () => {
    const names = [
      ...new Set(
        sources(sourceRoot).flatMap((source) =>
          [...source.matchAll(/process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g)].map(
            (match) => match[1],
          ),
        ),
      ),
    ];
    expect(names).toContain("NEXT_PUBLIC_ARTFI_WHOLE_ARTWORK_MARKET_ADDRESS");
    expect(names).toContain("NEXT_PUBLIC_ARTFI_FRACTION_MARKET_ADDRESS");
    for (const name of names) {
      expect(dockerfile).toContain(`ARG ${name}=""`);
      expect(dockerfile).toContain(`${name}=$${name}`);
    }
    expect(dockerfile).not.toMatch(
      /ARG\s+(?:ARTFI_OPERATOR_SESSION_SECRET|ARTFI_OPERATOR_BEARER_TOKEN|R2_SECRET_ACCESS_KEY)/,
    );
  });

  it("reports the exact deployed commit without claiming unset provenance", async () => {
    vi.stubEnv("ARTFI_BUILD_SHA", "555572b33bc4ec2f8887b6dd739d92cc705965f9");
    expect(await GET().json()).toMatchObject({
      chainId: 560048,
      buildRevision: "555572b33bc4ec2f8887b6dd739d92cc705965f9",
      status: "ok",
    });
    vi.stubEnv("ARTFI_BUILD_SHA", "");
    expect((await GET().json()).buildRevision).toBeNull();
    vi.stubEnv("ARTFI_BUILD_SHA", "invalid-value");
    expect((await GET().json()).buildRevision).toBeNull();
  });
});
