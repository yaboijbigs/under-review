import type { Metadata } from "next";
import Link from "next/link";
import { listCorrections } from "@under-review/core/repository";
import { EmptyState, PageIntro, Unavailable } from "@/components/ui";
import { dateTime } from "@/lib/presentation";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {title: "Corrections & revisions"};
export default async function Corrections() { let entries: Awaited<ReturnType<typeof listCorrections>> = []; let error=false; try {entries=await listCorrections();} catch {error=true;} return <><PageIntro eyebrow="THE RECORD REMAINS OPEN" title="Corrections & revisions."><p>New data can change a finding. Revisions preserve the original record and explain what changed.</p></PageIntro>{error ? <Unavailable/> : entries.length ? <div className="corrections-list">{entries.map(entry => <article key={`${entry.gameId}-${entry.number}`}><time>{dateTime(entry.createdAt)}</time><div><h2><Link prefetch={false} href={`/games/${encodeURIComponent(entry.gameId)}?revision=${entry.number}`}>{entry.gameId.replace(/_/g," ")} <span>↗</span></Link></h2><span className="eyebrow">REVISION {entry.number}</span><p>{entry.changeSummary}</p></div></article>)}</div> : <EmptyState title="No published revisions yet">When a report is enriched or corrected, the change will be recorded here.</EmptyState>}</>; }
