import type { NextConfig } from "next";

/**
 * Standalone output produces a minimal, self-contained server bundle
 * (server.js + only the node_modules actually used) under .next/standalone
 * — this is what the Dockerfile copies into the final image, keeping it
 * small and avoiding shipping the full dev-time node_modules tree.
 */
const nextConfig: NextConfig = {
  output: "standalone",

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
        ],
      },
    ];
  },
};

export default nextConfig;
