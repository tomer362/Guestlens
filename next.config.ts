import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // migrations run lazily from any route (lib/db/migrate.ts), so ship the SQL with every function
  outputFileTracingIncludes: { "/**/*": ["./drizzle/**/*.sql"] },
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
