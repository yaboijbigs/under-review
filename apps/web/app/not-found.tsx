import Link from "next/link";
import { PageIntro } from "@/components/ui";
export default function NotFound() { return <><PageIntro eyebrow="404 / OUTSIDE THE RECORD" title="This report isn't here."><p>The game or revision may not have been published yet. Check the archive for available reports.</p></PageIntro><Link className="button dark" href="/">Return to game reports →</Link></>; }
