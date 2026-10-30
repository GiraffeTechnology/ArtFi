import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const modulePath = process.env.ARTFI_PORTFOLIO_VITE_MODULE,
  output = process.env.ARTFI_PORTFOLIO_OUTPUT;
if (!modulePath || !output)
  throw Error("Set existing approved Vite module and task output paths.");
const { build } = await import(pathToFileURL(resolve(modulePath)).href);
await build({
  configFile: false,
  root: process.cwd(),
  cacheDir: resolve(output, "cache"),
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  resolve: {
    alias: [
      {
        find: /^wagmi$/,
        replacement: resolve("e2e-revenue-claim/fixtures/wagmi.ts"),
      },
      { find: "@", replacement: resolve("src") },
    ],
  },
  build: {
    rolldownOptions: { output: { codeSplitting: false } },
    outDir: resolve(output),
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: resolve("e2e-revenue-claim/fixtures/main.tsx"),
      name: "ArtFiRevenueClaimFixture",
      cssFileName: "style",
      formats: ["es"],
      fileName: () => "fixture.js",
    },
  },
});
