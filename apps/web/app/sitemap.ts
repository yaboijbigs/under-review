import type { MetadataRoute } from "next";
import { config } from "@under-review/core/config";
import { listGames } from "@under-review/core/repository";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (config.staging || process.env.DEMO_MODE === "true") return [];
  const pages: MetadataRoute.Sitemap = ["", "/methodology", "/sources", "/corrections", "/status"].map(path => ({url: new URL(path, config.siteUrl).href, changeFrequency: path ? "weekly" : "daily"}));
  try { const games = await listGames(); return [...pages, ...games.filter(game => game.revisionNumber !== null).map(game => ({url:new URL(`/games/${encodeURIComponent(game.id)}`,config.siteUrl).href, lastModified:game.updatedAt || undefined, changeFrequency:"weekly" as const}))]; } catch {return pages;}
}
