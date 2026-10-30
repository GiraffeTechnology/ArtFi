import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Use an existing approved Vite installation; this script installs nothing.
const modulePath = process.env.ARTFI_STATIC_SELECT_VITE_MODULE;
const output = process.env.ARTFI_STATIC_SELECT_OUTPUT;
if (!modulePath || !output)
  throw new Error(
    "Set ARTFI_STATIC_SELECT_VITE_MODULE and ARTFI_STATIC_SELECT_OUTPUT to existing approved runtime and task output paths.",
  );
const { build } = await import(pathToFileURL(resolve(modulePath)).href);
await build({
  configFile: false,
  root: process.cwd(),
  cacheDir: resolve(output, "cache"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: {
      "@": resolve("src"),
      "next/navigation": resolve(
        "e2e-static-select/fixtures/static-select/navigation.ts",
      ),
    },
  },
  build: {
    outDir: resolve(output),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve("e2e-static-select/fixtures/static-select/main.tsx"),
      name: "ArtFiFixture",
      formats: ["iife"],
      fileName: () => "fixture.js",
    },
  },
});
