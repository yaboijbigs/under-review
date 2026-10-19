import GameArchive, { type ArchiveQuery } from "@/components/game-archive";

// Queries are routed here through /archive; the unfiltered homepage uses ISR.
export const dynamic = "force-dynamic";
export default async function Home({searchParams}: {searchParams: Promise<ArchiveQuery>}) {
  return <GameArchive query={await searchParams} cacheData/>;
}
