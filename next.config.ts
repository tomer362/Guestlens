import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // migrations run lazily from any route (lib/db/migrate.ts), so ship the SQL with every function
  outputFileTracingIncludes: {
    "/**/*": ["./drizzle/**/*.sql"],
    // routes that can run the face pipeline (FACES.md): ship the ONNX models and the runtime,
    // which lib/faces/model.ts imports at runtime (webpackIgnore), so the tracer can't see them
    ...Object.fromEntries(["/api/media/complete", "/api/blob/token", "/api/gallery/version", "/api/cron/faces", "/api/admin/faces"].map((r) => [r, [
      "./lib/faces/models/*.onnx",
      "./node_modules/onnxruntime-web/package.json",
      "./node_modules/onnxruntime-web/dist/ort.node.min.mjs",
      "./node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{wasm,mjs}",
      "./node_modules/onnxruntime-common/**/*",
    ]])),
  },
  serverExternalPackages: ["sharp"],
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
