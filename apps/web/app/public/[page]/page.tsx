import type { Metadata } from "next";
import { notFound } from "next/navigation";
import GameArchive from "@/components/game-archive";
import Methodology, { metadata as methodologyMetadata } from "@/app/methodology/page";
import Sources, { metadata as sourcesMetadata } from "@/app/sources/page";
import Corrections, { metadata as correctionsMetadata } from "@/app/corrections/page";

// Rewrites keep the existing public URLs. Empty params defer rendering to the VPS,
// where runtime branding, indexing settings, and the database are available.
export const revalidate = 60;
export function generateStaticParams() { return []; }

type Props = {params: Promise<{page: string}>};
export async function generateMetadata({params}: Props): Promise<Metadata> {
  const {page} = await params;
  switch (page) {
    case "home": return {alternates: {canonical: "/"}};
    case "methodology": return {...methodologyMetadata, alternates: {canonical: "/methodology"}};
    case "sources": return {...sourcesMetadata, alternates: {canonical: "/sources"}};
    case "corrections": return {...correctionsMetadata, alternates: {canonical: "/corrections"}};
    default: notFound();
  }
}
export default async function PublicPage({params}: Props) {
  const {page} = await params;
  switch (page) {
    case "home": return <GameArchive/>;
    case "methodology": return <Methodology/>;
    case "sources": return <Sources/>;
    case "corrections": return <Corrections/>;
    default: notFound();
  }
}
