import ReportPage from "@/components/game-report";
export { generateMetadata } from "@/components/game-report";

export const revalidate = 60;
// Generate on the first request, without requiring a database during the build.
export function generateStaticParams() { return []; }
export default function GamePage({params}: {params: Promise<{gameId: string}>}) {
  return <ReportPage params={params}/>;
}
