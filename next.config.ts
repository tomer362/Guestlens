import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // the /api/setup route reads the SQL migrations at runtime
  outputFileTracingIncludes: { "/api/setup": ["./drizzle/**/*.sql"] },
  images: { unoptimized: true }, // thumbs are already 400px WebP made on the phone; skip Vercel image optimization quota
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};
export default nextConfig;
