import type { MetadataRoute } from "next";
import { config } from "@under-review/core/config";
export default function robots(): MetadataRoute.Robots { return config.staging || process.env.DEMO_MODE === "true" ? {rules:{userAgent:"*",disallow:"/"}} : {rules:{userAgent:"*",allow:"/",disallow:["/admin", "/api/"]},sitemap:new URL("/sitemap.xml",config.siteUrl).href}; }
