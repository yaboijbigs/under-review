import { notFound } from "next/navigation";
import ReportPage from "@/components/game-report";
export { generateMetadata } from "@/components/game-report";

export const revalidate = 60;
export function generateStaticParams() { return []; }
export default async function RevisionPage({params}: {params: Promise<{gameId: string; revision: string}>}) {
  const {gameId, revision} = await params;
  const revisionNumber = Number(revision);
  if (!Number.isSafeInteger(revisionNumber) || revisionNumber < 1) notFound();
  return <ReportPage params={Promise.resolve({gameId})} revisionNumber={revisionNumber}/>;
}
