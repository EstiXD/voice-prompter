import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Todo corre en el navegador: no hay API routes ni secretos.
  headers: async () => [
    {
      // Los worklets/wasm de RNNoise no cambian entre deploys salvo bump de versión.
      source: "/worklets/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
    },
  ],
};

export default nextConfig;
