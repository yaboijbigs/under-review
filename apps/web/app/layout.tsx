import type { Metadata } from "next";
import Link from "next/link";
import { config } from "@under-review/core/config";
import "./globals.css";
export const metadata: Metadata = { metadataBase: new URL(config.siteUrl), title: {default: `${config.brandName} — The game. The evidence.`, template: `%s | ${config.brandName}`}, description: "Independent NFL postgame analysis. Separate ruling impact, reviewed errors, coaching, execution, and fortune—with the evidence in view.", robots: {index: !config.staging && process.env.DEMO_MODE !== "true", follow: !config.staging && process.env.DEMO_MODE !== "true"} };
function Brand() {
  if (config.brandName === "Under Review") return <>UNDER<span>REVIEW<span className="brand-square" aria-hidden="true"/></span></>;
  return <>{config.brandName.toUpperCase()}<span className="brand-square" aria-hidden="true"/></>;
}
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>
    <a className="skip-link" href="#main">Skip to content</a>
    <header className="site-header"><div className="header-inner">
      <Link className="wordmark" href="/" aria-label={`${config.brandName} home`}><Brand/></Link>
      <nav aria-label="Main navigation"><Link href="/">Game reports</Link><Link href="/methodology">Methodology</Link><Link href="/sources">Sources</Link></nav>
      <span className="header-tag">INDEPENDENT<br/>POSTGAME ANALYSIS</span>
    </div></header>
    {process.env.DEMO_MODE === "true" ? <div className="demo-banner">DEMONSTRATION MODE · Synthetic content is excluded from indexing and social publishing.</div> : config.staging ? <div className="demo-banner">STAGING PREVIEW · Search indexing and live social publishing are disabled.</div> : null}
    <main id="main" className="main-shell">{children}</main>
    <footer className="site-footer"><div>
      <Link href="/" className="footer-brand">{config.brandName.toUpperCase()}<span className="brand-square" aria-hidden="true"/></Link>
      <p>{config.tagline}</p>
      <p className="disclaimer">Independent analysis. Not affiliated with the NFL or its teams. Rarity is not evidence of manipulation.</p>
    </div><nav aria-label="Footer navigation"><Link href="/methodology">Methodology</Link><Link href="/sources">Data & attribution</Link><Link href="/corrections">Corrections</Link><Link href="/status">System status</Link><Link href="/admin">Operator access</Link></nav>
      <span className="footer-edition">EST. 2026<br/>THE RECORD REMAINS OPEN</span>
    </footer>
  </body></html>;
}
