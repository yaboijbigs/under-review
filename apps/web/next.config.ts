import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@under-review/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  // Cloudflare compresses at the edge; avoid gzip CPU and stream listeners here.
  compress: false,
  // The single VPS web container has a read-only root filesystem. Keep ISR in a
  // bounded process-local LRU; pages regenerate after eviction or a restart.
  cacheMaxMemorySize: 32 * 1024 * 1024,
  experimental: {isrFlushToDisk: false},
  async rewrites() {
    return {
      beforeFiles: [
        // Query-dependent views retain their existing URLs and behavior.
        ...["season", "week", "team", "result"].map(key => ({
          source: "/", has: [{type: "query" as const, key}], destination: "/archive",
        })),
        {
          source: "/games/:gameId",
          has: [{type: "query", key: "revision", value: "(?<revision>[1-9][0-9]*)"}],
          destination: "/games/:gameId/revisions/:revision",
        },
        // Dynamic path segments allow runtime ISR without build-time DB/config.
        {source: "/", destination: "/public/home"},
        ...["methodology", "sources", "corrections"].map(page => ({
          source: `/${page}`, destination: `/public/${page}`,
        })),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default config;
