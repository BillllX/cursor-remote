import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
