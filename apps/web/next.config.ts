import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {},
  webpack(config, { dev }) {
    if (config.cache && !dev) {
      config.cache = Object.freeze({ type: "memory" });
    }
    return config;
  },
  experimental: {
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
  },
};

export default nextConfig;
