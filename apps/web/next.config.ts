import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    // Keep the full project check in the installed compiler CLI.
    useTypeScriptCli: true,
  },
};

export default nextConfig;
