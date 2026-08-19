import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  output: "standalone",
  outputFileTracingRoot: path.join(process.cwd(), "../.."),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
