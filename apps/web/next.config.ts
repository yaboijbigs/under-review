import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  transpilePackages: ["@under-review/core"],
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  webpack(config) {
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};
export default config;
