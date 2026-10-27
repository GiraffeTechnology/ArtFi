import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPortableBundleLinks } from "./bundle-portable-links.mjs";

async function fixture(run) {
  const scratch = await mkdtemp(join(tmpdir(), "artfi-portable-links-"));
  try {
    const root = join(scratch, "artifact");
    await mkdir(join(root, "node_modules/.store/example"), { recursive: true });
    await writeFile(
      join(root, "node_modules/.store/example/index.mjs"),
      "export const value = 1;\n",
    );
    await writeFile(
      join(scratch, "outside.txt"),
      "SYNTHETIC_PRIVATE_BOUNDARY\n",
    );
    return await run({ root, scratch });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test("retains relative dependency and package self-reference links inside the artifact", async () => {
  await fixture(async ({ root }) => {
    await symlink(".store/example", join(root, "node_modules/example"));
    await symlink(".", join(root, "node_modules/.store/example/self"));
    assert.deepEqual(await assertPortableBundleLinks(root), {
      links: 2,
      status: "PORTABLE_WITHIN_BUILD_ROOT",
    });
  });
});

test("refuses absolute links even when their current target is internal", async () => {
  await fixture(async ({ root }) => {
    await symlink(
      join(root, "node_modules/.store/example"),
      join(root, "absolute"),
    );
    await assert.rejects(assertPortableBundleLinks(root), /non-portable/);
  });
});

test("refuses relative escapes and does not include the private target in diagnostics", async () => {
  await fixture(async ({ root, scratch }) => {
    await symlink("../outside.txt", join(root, "escape"));
    await assert.rejects(assertPortableBundleLinks(root), (error) => {
      assert.match(error.message, /escaping filesystem entry/);
      assert.equal(error.message.includes(scratch), false);
      assert.equal(error.message.includes("outside.txt"), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

test("refuses a lexically internal link whose intermediate directory resolves outside", async () => {
  await fixture(async ({ root }) => {
    await symlink("..", join(root, "bridge"));
    await symlink("bridge/outside.txt", join(root, "through-bridge"));
    await assert.rejects(assertPortableBundleLinks(root));
  });
});

test("refuses broken targets and symbolic-link cycles", async () => {
  for (const mode of ["broken", "cycle"]) {
    await fixture(async ({ root }) => {
      await symlink(
        mode === "broken" ? "missing" : "second",
        join(root, "first"),
      );
      if (mode === "cycle") await symlink("first", join(root, "second"));
      await assert.rejects(assertPortableBundleLinks(root), /non-portable/);
    });
  }
});

test("root resolution failures and linked roots do not expose private filesystem paths", async () => {
  await fixture(async ({ root, scratch }) => {
    const alias = join(scratch, "artifact-alias");
    await symlink(root, alias);
    for (const directory of [join(scratch, "missing"), alias]) {
      await assert.rejects(assertPortableBundleLinks(directory), (error) => {
        assert.match(error.message, /non-portable/);
        assert.equal(error.message.includes(scratch), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });
});
