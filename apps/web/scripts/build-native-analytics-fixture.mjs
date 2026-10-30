import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
if (
  !process.env.ARTFI_ANALYTICS_VITE_MODULE ||
  !process.env.ARTFI_ANALYTICS_OUTPUT
)
  throw Error("Existing Vite module and test output required.");
const { build } = await import(
  pathToFileURL(resolve(process.env.ARTFI_ANALYTICS_VITE_MODULE)).href
);
await build({
  configFile: false,
  root: process.cwd(),
  cacheDir: resolve(process.env.ARTFI_ANALYTICS_OUTPUT, "cache"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: { alias: [{ find: "@", replacement: resolve("src") }] },
  build: {
    outDir: resolve(process.env.ARTFI_ANALYTICS_OUTPUT),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve("e2e-native-analytics/fixtures/main.tsx"),
      name: "ArtFiNativeAnalyticsFixture",
      cssFileName: "style",
      formats: ["iife"],
      fileName: () => "fixture.js",
    },
  },
});
