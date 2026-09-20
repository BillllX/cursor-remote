import type { NextConfig } from "next";
import pkg from "./package.json";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    // hello.client 版本上报用
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  ...(basePath ? { basePath } : {}),
  async headers() {
    return [
      {
        source: "/canvas-runtime",
        headers: [{ key: "Cache-Control", value: "public, max-age=60, stale-while-revalidate=3600" }],
      },
    ];
  },
};

export default nextConfig;
