import type { NextConfig } from "next";
import pkg from "./package.json";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // lint 由根目录 npm run lint 单独跑；不让 next build 去找 eslint-config-next
  eslint: { ignoreDuringBuilds: true },
  env: {
    // hello.client 版本上报用
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 允许编译 web/ 外的 ../shared（与网关共用的协议等）；构建时整体打进 .next，运行时不再读 ../shared
  experimental: { externalDir: true },
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
