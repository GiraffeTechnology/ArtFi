import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const modulePath = process.env.ARTFI_MARKET_VITE_MODULE;
const output = process.env.ARTFI_MARKET_OUTPUT;
if (!modulePath || !output)
  throw new Error(
    "Set existing approved Vite module and task output paths in ARTFI_MARKET_VITE_MODULE and ARTFI_MARKET_OUTPUT.",
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
      "next/link": resolve("e2e-market-server/fixtures/link.tsx"),
      "next/font/local": resolve("e2e-market-server/fixtures/font.ts"),
    },
  },
  build: {
    outDir: resolve(output),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve("e2e-market-server/fixtures/main.tsx"),
      name: "ArtFiMarketFixture",
      formats: ["iife"],
      fileName: () => "fixture.js",
    },
  },
});
