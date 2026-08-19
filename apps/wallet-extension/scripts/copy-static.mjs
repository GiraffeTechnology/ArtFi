import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist", import.meta.url), { recursive: true });
await Promise.all(
  ["manifest.json", "popup.html"].map((file) =>
    copyFile(
      new URL(`../${file}`, import.meta.url),
      new URL(`../dist/${file}`, import.meta.url),
    ),
  ),
);
