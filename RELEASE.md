# Under Review release record

The public website is **[underreview.jbigs.com](https://underreview.jbigs.com)**. Its public deployment and coverage upgrades succeeded on **2026-09-22 UTC** with user approval. The MIT-licensed source is public at [yaboijbigs/under-review](https://github.com/yaboijbigs/under-review). All **32 completed 2026 Week 1–2 games** have game audits. Giants–Rams was discovered and analyzed automatically; the coverage gate confirmed 32 of 32 at **03:41:15.466 UTC**. Private environment files, administrator credentials, database exports, backups, and caches are excluded from Git and image build contexts; release files are scanned before publishing.

## Overall ratings and experimental overtime — local verification

The five-tier game rating uses Fair, Debatable, Hmm, Sus and RIGGED?. The highest tier requires a historically rare winning profile and at least three distinct penalty drive extensions favoring the same winner. These fixed screening rules do not establish manipulation; ordinary review-candidate counts cannot escalate a rating. GB–NYJ and GB–MIN each rate Sus for their respective supported evidence. Cards, report explanations, filters and share images use the same rule implementation.

The separate overtime estimator uses 2,136 eligible states from 131 prior regular-season games, distinguishes win/loss/tie, and requires at least 20 comparable prior games. New-rule opening possessions currently have only 14 reference games; touchdown responses, complex possession changes and postseason phases remain unavailable. Local stored GB–NYJ and IND–KC reports respectively contain five and eight experimental OT estimates, with their observed final results shown separately. Audit v3 refreshes stored reports without rerunning unchanged R metrics. The reference SHA-256 is `b53e6bc3fd9719ffc73efa899dd84aa115eb829126d972a2f9c6e595005d9824`; [method and chronological diagnostics](analytics/OVERTIME.md) document the limited coverage and uncalibrated status.

All 295 unit/integration tests across 24 files passed, including real PostgreSQL checks. Typechecking and the production build passed. Six focused rating browser checks and two overtime chart checks passed across desktop/mobile. Publication and live deployment are recorded below only after verification.

## Warm database connections — deployed and verified 2026-09-22 UTC

The follow-up web release from `a2682ee5008e6341d91ad8f69fbaf55cbf2c7278` passed [CI run 35688904861](https://github.com/yaboijbigs/under-review/actions/runs/35688904861). Its immutable image is `ghcr.io/yaboijbigs/under-review-web@sha256:d8434b8bf59878a8e18e7af2ab15f996e147c48a16d98c485d70c88e9579568a`, anonymously checksum-verified at **05:00:27.899 UTC**. The worker image remains unchanged. Under Review-only stop **115936263** succeeded at **05:01:59**; deployment **115936734** succeeded at **05:05:25 UTC**. The project backup completed at **05:04:00.724 UTC** in `/data/backups/20260922T050236Z-public-launch`. The applied configuration and private environment exactly matched the submitted project.

The web retains one established database connection, gives new connections/checkouts 15 seconds, and retires surplus idle clients after five minutes. The maximum remains five; there is no added retry or CPU/memory allocation. Twelve focused tests passed, including real PostgreSQL connection reuse, a stalled TCP handshake ending after 15 seconds with one attempt and no leaked client, and report-contract preservation. Typechecking and the production build passed. The staged-source secrets scan passed across 225 files.

After deployment, **30 public desktop/mobile browser checks passed; two optional fixture cases were skipped**. Concurrently, a complete archive tour loaded **all 32 reports** with no error views or browser exceptions. The web log contained **zero `web.report.failed` entries** after these checks. Desktop/mobile layout and PNG sharing checks also passed; GB–NYJ showed revision 4 with its clean `nflverse-pbp` source and preserved 6-of-414 historical comparison. Coverage confirmed all **32 current v2 audits** at **05:04:49.802 UTC**. Nine unrelated projects / 30 containers were unchanged; the apex page remained byte-identical and www kept its original redirect. These results close the earlier pool-checkout and initial-connection failures recorded below.

## Report loading reliability — deployed 2026-09-22 UTC

Hostinger action **115930310** succeeded at **04:45:14 UTC**, following the Under Review-only stop action **115929838** and a verified backup at `/data/backups/20260922T044243Z-public-launch` completed at **04:43:57.580 UTC**. Web source `857016a70f8c64421f9779bbf9f5a07baf685dc9` was built in [CI run 35687046072](https://github.com/yaboijbigs/under-review/actions/runs/35687046072) and anonymously verified at **04:31:43.405 UTC** as `ghcr.io/yaboijbigs/under-review-web@sha256:24ee2689286bb44c9eb5a5b63d96bd0c8213e5cb6da946d7c2bf78ddf9eae6e4`. The worker remains the verified `f7152cb` / `6699b47e…` artifact in the following section.

Report loading now uses one database query instead of five concurrent checkouts, preserving stored game metadata, sources, historical revisions, human reviews and drafts in one consistent SQL snapshot. The remaining operator-desk report links also disable automatic prefetching. Resource limits and timeout budgets were not increased. All **239 unit/integration tests across 21 files**, typechecking and the production web build passed. Ten focused local desktop/mobile browser cases passed. The actual release image also completed **nine of nine** real-report requests across three concurrent-browser rounds at the production web limit of **0.10 CPU / 512 MiB**, without error views or pool timeouts; this local database/network experiment is not a VPS latency guarantee.

The applied configuration and private environment exactly matched the submitted project. After restart, coverage passed at **04:44:37.986 UTC** with **32 scheduled, 32 completed and 32 current v2 audits**, no missing audits and no games awaiting final data. Backup, bootstrap, coverage and route-check containers exited successfully; the database, worker and web were healthy. Nine unrelated projects / 30 containers retained their IDs, images, ports and states. The `jbigs.com` page remained byte-identical and `www.jbigs.com` retained its original redirect. Private volumes, the dedicated subdomain route, resource limits and disabled live social posting were preserved.

The independent public report tour completed **32 of 32** reports with no rendered errors or browser exceptions. The concurrent desktop/mobile suite nevertheless found a separate initial-connection timeout: **27 passed, three failed, two skipped**. Both GB–NYJ failures logged `Connection terminated due to connection timeout` at **04:51:51.743** and **04:53:36.340 UTC**; the mobile operator desk also rendered a connection error. The pg driver terminates a new handshake after the configured five seconds. These failures remain recorded; the successful sequential tour is not a claim that this release passed concurrent browsing.

## Drive review and connected momentum charts — deployed 2026-09-22 UTC

Hostinger action **115920197** succeeded at **04:18:50 UTC**, following the project-only stop action **115920001** and a verified backup at `/data/backups/20260922T041559Z-public-launch` completed at **04:17:23.904 UTC**. The submitted 5,204-character configuration and private environment exactly matched the applied project. Anonymous registry checks passed at **04:12:47.133 UTC** for these artifacts:

| Component | Source | Immutable image | Build |
| --- | --- | --- | --- |
| Web | `52f641c2a7e26df221c1e9f07a405ab1d27ad48e` | `ghcr.io/yaboijbigs/under-review-web@sha256:8191d6fba26281a6b3390139daf77b2cf43b27df29f5bd57719e142cfd5ad301` | [Web build](https://github.com/yaboijbigs/under-review/actions/runs/35685226168) |
| Worker | `f7152cb580c8d4b06f44610d94948c5505b994d3` | `ghcr.io/yaboijbigs/under-review-worker@sha256:6699b47e13e7f2b2ee54a07b2ae72ff0abc93358cb99def891a8ade0eddfe89e` | [Worker and analytics tests](https://github.com/yaboijbigs/under-review/actions/runs/35685099170) |

Audit v2 fixes a concrete blind spot: the old late-penalty rule missed three GB–MIN third-down first downs awarded by penalties at Q4 11:03, 9:12 and 6:49. The new uniform rule checks third/fourth-down defensive-penalty first downs throughout a game and groups distinct qualifying plays by an explicit provider drive and offensive team. It excludes declined, offsetting, ambiguous, conflicting duplicate and independently converted plays. GB–MIN drive 19 now groups plays **3411, 3489 and 3592**; the live refresh completed at **04:18:31.700 UTC**. These are review priorities, not adjudicated errors. The feed contains no holding flag on the two-point conversion, so the alleged noncall still requires external evidence and human review.

Momentum lines now connect available estimates without creating intermediate values. Every recorded entry remains inspectable, unsupported overtime is shaded and labeled, and the line stops at the final supported estimate. For IND–KC this means **138 estimates across 202 entries**, including 33 unsupported overtime entries and 31 other entries without estimates; no source plays were missing. The chart explains its preplay, regulation-only model and recorded-entry horizontal axis.

Report links no longer prefetch every report while browsing cards. The regression detected 16 unnecessary requests before the change and zero afterward. The first consumer-release verification had one transient report connection failure; the change removes the demonstrated excess traffic and adds safe report-error logging, rather than concealing failures behind a generic retry. Browser checks wait for resolved streamed content and explicitly reject rendered data errors.

All **238 unit/integration tests across 21 files**, typechecking, the web production build and CI analytics checks passed. Six focused local desktop/mobile browser cases passed for connected charts, grouped drive evidence and absent report prefetches. Bootstrap recovers expired leases before queuing the explicitly scoped Weeks 1–2 upgrade; active leases remain untouched. Audit refresh preserves stored R findings unless a legacy raw-over-clean conflict requires fresh clean analysis in the same job. Public readiness permits existing validated reports while the separate coverage gate waits for the new audit version. Historical v1 import bundles are not replayed by this deployment.

After deployment, the homepage and GB report rendered on desktop/mobile with no browser errors; the share image was a valid PNG. Nine unrelated projects / 30 containers retained their IDs, images, ports and states. The `jbigs.com` page remained byte-identical, and `www.jbigs.com` retained its original redirect. Resource limits, private volumes, the dedicated subdomain route and disabled live social posting were preserved.

The full public suite then found two report pool-checkout timeouts under concurrent browsing (GB–MIN at **04:20:23.890**, GB–NYJ at **04:22:50.482**). Its outcome was **28 passed, two failed, two skipped**; one test failure was the real report error and one was a five-second assertion against the still-streaming admin page. An independent report tour also correctly failed on the second real error. These failures were investigated rather than counted as successful verification. The follow-up web update consolidates report loading into one database query and removes the remaining operator-desk report prefetches; resource caps and timeout budgets stay unchanged.

Audit v2 coverage subsequently completed for **all 32 games** at **04:40:24.790 UTC**. The legacy GB–NYJ clean reconciliation finished at **04:26:55.594**, and MIN–CHI at **04:39:41.503**; each retained prior report history. All other v2 refreshes preserved their stored R findings. No audit upgrades remained pending at that coverage check.

## Consumer verdicts and source recovery — deployed 2026-09-22 UTC

Hostinger action **115913062** succeeded at **03:31:38 UTC**, after Under Review's own backup completed at `/data/backups/20260922T032922Z-public-launch` at **03:30:27.916 UTC**. Web source `c7ec00fbc721ba9e0cc6138d640074bf1e75ceb5` and worker source `a0c6350a512e5c9286d8b52d1120c70bac16ef58` delivered plain-language verdicts, full team names, working result/week/team filters, readable evidence links and separate automatic-analysis, source-data and human-review statuses. The share image uses the same verdict. The main page no longer treats an absent human review as an unfinished automatic report.

Persistence now records source kind independently of report status and rejects raw-over-clean writes. Dispatch reevaluates source maturity, and startup repairs only provably equivalent regressions; changed findings require new clean analysis. Existing revisions and stale human-review records are retained. Future scheduled reconciliation no longer blocks work due immediately. All **207 tests across 21 files** passed before this deployment, including PostgreSQL regressions, typechecking and the production web build. The deployed seed check passed all eight routes. Nine unrelated projects / 30 containers retained their IDs, images, ports and states; `jbigs.com` remained byte-identical and `www.jbigs.com` retained its redirect.

The worker automatically finished the Giants–Rams analysis at **03:40:58.291 UTC**. This is executed automatic processing, not a promise of later completion. At that point every Week 1–2 game had an audit. Source limitations remain visible; audit presence does not imply complete model coverage or an officiating-correctness finding.

## Executed first public release — 2026-09-22 UTC

Hostinger deployment action **115905298** succeeded at **01:15:15 UTC**. The dedicated Cloudflare Tunnel serves **https://underreview.jbigs.com** from **`http://web:3000`** on Under Review's private network. The `jbigs.com` apex, `www.jbigs.com`, unrelated routes/tunnels, and shared ports 80/443 were preserved. The application's existing loopback binding remains `127.0.0.1:4380`; PostgreSQL has no host binding.

Both first-launch images were published and anonymously verified by manifest content checksum and immutable-digest resolution at **00:30:52.534 UTC**, then deployed successfully. These exact digests identify the executed release, independently of later updates to [deploy/images.json](deploy/images.json):

| Component | Source revision | Immutable image | Build |
| --- | --- | --- | --- |
| Web with tested public-login fix | `4bbc02dfb186e633f62f0e8cd83d34d18158d487` | `ghcr.io/yaboijbigs/under-review-web@sha256:05e1be47e8a4ba4036c3850be314a7f2b03e983f8b656d770ff6d9ce17b31bc8` | [Successful web-only run](https://github.com/yaboijbigs/under-review/actions/runs/35671937726) |
| Worker, game audit, R runtime and model artifacts | `4d4da0ae0ef19bde46bec12c0298ae6bc3f3bff6` | `ghcr.io/yaboijbigs/under-review-worker@sha256:889135ddf364911ba2d3568d12f4ea9c3aa87cb7fbf0dcd1baec2862b841376a` | [Successful full runtime run](https://github.com/yaboijbigs/under-review/actions/runs/35671211998) |

The worker job restored pinned R dependencies from a fresh CI environment, passed analytics tests, built the worker and published it in **13 minutes 26 seconds**. The separate web-only run incorporated the login fix without rebuilding the worker. The audit's 29 focused tests and TypeScript check passed locally. A read-only exploratory diagnostic surfaced all five selected historical target plays; the comparison games produced zero and three neutral review candidates. Those known cases motivated product rules and are not held-out classifier validation. No model fitting or dependency compilation is planned on the shared VPS.

Local preparation passed the manifest's isolation boundaries, inline JavaScript checks, and the real GB report with a dry-run draft. The release passed a secrets scan across 200 files. Deployment then produced this executed evidence:

| UTC time | Executed result |
| --- | --- |
| 01:06:36 | Project-only backup completed at `/data/backups/20260922T010533Z-public-launch`: PostgreSQL custom dump, readable dump catalog, gzip snapshot archive, and SHA-256 checksums. |
| 01:07:06–01:14:23 | Clean-source `2026_02_GB_NYJ` analysis completed with **74 metric records and one dry-run draft**, under the configured VPS limits. |
| 01:15:03 | Seed report gate passed; all eight ordinary web/readiness routes returned **200**. |
| 01:15:06 | Dedicated public tunnel started after the gate. |
| 01:15:15 | Hostinger action **115905298** completed successfully. |
| 01:28 | Comparison of **nine unrelated projects / 30 containers** found unchanged IDs, images, published ports, and running/stopped states. |

Only Under Review was stopped/replaced, retaining its named volumes. The backup is an executed **same-host capture on the artifact volume**, not an off-host backup or VPS restore test. The GB gate verified its complete aggregate winning profile, versioned audit, checksummed reference and historical-outlier flag, supported metrics, and current-revision draft. The expected seed result is a release fixture, not independent statistical validation. The unrelated-container comparison establishes container-level continuity, not end-user testing of every other application.

Public HTTPS, `/api/health`, and `/api/ready` returned **200**. Desktop and mobile browser checks passed the GB profile/headline, five review candidates, full source-play links, layout, and absence of page/Next-asset errors. Authentication checks passed unauthenticated admin protection, admin noindex, same-origin login, a host-only `Secure; HttpOnly; SameSite=Lax` session cookie, rejected foreign-origin login, rejected invalid-CSRF logout, and successful logout/session removal. No admin content or publishing settings were changed. Private evidence is retained under ignored `deploy/private/public-browser-check-evidence/`; credentials and session values were not recorded.

The first browser check found one public indexing defect: the sitemap omitted published early-week games because unprocessed schedules consumed the 400-row listing limit. The fix filters published reports before that limit; its isolated PostgreSQL regression and typecheck passed. **The second public verification confirmed the deployed fix includes all 31 scored Week 1–2 report URLs.**

Worker **0.25 CPU / 1536 MiB**, web **0.10 CPU / 512 MiB**, and database **0.15 CPU / 512 MiB** limits remain configured. The tunnel is capped at **0.05 CPU / 128 MiB**; bounded one-shot services, one analysis worker/R thread, a 15-minute analytics timeout, bounded logs/PIDs and the 5 GiB disk reserve remain in place. Public access does not enable posting: live posting remains disabled, drafts remain dry-run, and the kill switch stays enabled. [OPERATIONS.md](OPERATIONS.md) records the sequence and recovery limits.

## Weeks 1–2 coverage upgrade — deployed and verified

The user confirmed **2026 regular-season Weeks 1 and 2**, including automatic analysis of `2026_02_NYG_LA` after final data is available. The fresh 32-game schedule contained **31 games with scores** and that one unscored game. The initial public observation found **20 reports, two computed game audits, 11 completed games without reports, and 18 reports without the new audit**. This was a snapshot during ongoing processing, not a final coverage result.

The 11 missing reports were computed and exported locally as checksummed bundles of public source data and automated analysis. Import completed with ten new reports and preservation of the existing `2026_02_IND_KC` report. Seventeen older audits were refreshed, preserving their R findings. All 31 completed games now have current audits. The new worker includes bounded catch-up commands and schedule/new-game priority; the new web serves the sitemap fix. Tonight's Giants–Rams game remained unscored and correctly awaited final data at verification. TB–CIN's aggregate score conflict remains explicitly labeled, with unsupported team profiles withheld; its play-by-play analysis is available.

Source **`9122aed3f2599ac8db5a7e4a0a0810aa83840837`** built successfully in [CI run 35676946141](https://github.com/yaboijbigs/under-review/actions/runs/35676946141). Local validation passed **169 tests across 17 files**, typechecking, a real bundle export/import round trip, and a source secrets scan of 213 files. The three resulting images were anonymously verified at **02:00:40.995 UTC** and recorded in [deploy/images.json](deploy/images.json):

| Component | Verified immutable image |
| --- | --- |
| Web | `ghcr.io/yaboijbigs/under-review-web@sha256:f937699ae315d711ae6967e7c70293bf79788f9a466cde5431948d3bd97be32e` |
| Worker | `ghcr.io/yaboijbigs/under-review-worker@sha256:2f75aba3b772c315d804eed41dc17caceba186c8707bbccdf96e04db45429dee` |
| Public-source catch-up bundles and importer | `ghcr.io/yaboijbigs/under-review-catchup@sha256:2daa4f09115571fb45c5c108bf3009ec1374b062e2d0c33c599a51913516a86d` |

Hostinger rejected the **9,775-character** full YAML because its limit is **8,192**; that rejected request applied no changes. [scripts/compact-hostinger-compose.mjs](scripts/compact-hostinger-compose.mjs) reproduces the accepted **8,187-character** manifest with JavaScript syntax and parsed-setting checks. The exact generation command is in [OPERATIONS.md](OPERATIONS.md).

| UTC time | Executed replacement result |
| --- | --- |
| 02:03:26 | Project-only stop action **115908477** succeeded. |
| 02:07:07 | Deployment action **115908663** was accepted. |
| 02:10:03.586 | Backup completed at `/data/backups/20260922T020904Z-public-launch`. |
| 02:11:11 | First bundle import, `2026_01_ATL_PIT`, succeeded. |
| 02:16:20.055 | Import completed: ten new reports, existing IND–KC preserved, 17 audit refreshes queued. |
| 02:17:12.448 | GB/web check passed all eight routes with HTTP 200; GB revision 2, 74 metric records, two dry-run drafts. Worker healthy; live posting disabled and kill switch enabled. |
| 02:17:20 | Hostinger deployment action **115908663** succeeded. |
| ~02:17:25 | Public tunnel route reopened. |
| 02:18:41–02:19:23 | All eight public browser check groups passed, including desktop/mobile reports, evidence links, all 31 scored-game sitemap links, authentication, origin/CSRF rejection, secure cookies, and logout. |
| 02:18:58.863 | All 17 audit refresh jobs finished successfully. |
| 02:19:57.055 | Independent coverage gate: 32 scheduled, 31 completed, 31 current audits, no missing audits; only NYG–LA awaiting final data. Coverage container exited 0. |
| 02:19–02:20 | Exact applied configuration/private environment verified; nine unrelated projects and 30 containers unchanged. Apex page remained byte-identical and www retained its 301 redirect. Database, web and worker healthy; all one-shot services exited 0. |
| 02:25:16.568 | Public browser inventory passed: all 31 completed reports rendered current audits; NYG–LA correctly awaited data. One early streamed NE–SEA page observation passed an explicit rendered-content recheck. |

The replacement sequence performed backup and idempotent bootstrap, ran `import` (**0.25 CPU / 1024 MiB**) before the worker, then passed both the ordinary GB/web `check` and separate `coverage` service (**0.05 CPU / 128 MiB**). The GB release-specific job key is reused, so an already successful seed need not rerun R. The tunnel depends on `check`; the independent coverage gate also passed before catch-up was declared complete. The public archive contains all 16 Week 1 and 15 completed Week 2 reports with current audits. Near games, the scheduler checks five-minute buckets between bounded analysis jobs and prioritizes newly completed games; final provider data remains required. Post-upgrade browser evidence is preserved separately under ignored `deploy/private/public-browser-check-upgrade-evidence/`. Existing worker, web, database and tunnel limits remain unchanged; live social posting remains disabled.

## Historical staging artifacts — deployed 2026-09-21

| Component | Source revision | Build |
| --- | --- | --- |
| Worker, R runtime, and model artifacts | `208bbf402b8ee2422dc0edb70676a718c8c236e3` | [Successful full runtime build](https://github.com/yaboijbigs/under-review/actions/runs/35639017767) |
| Web, including runtime branding/indexing configuration | `03818639368b1e4d140d5d2334da0efb3dffd2bc` | [Successful web build](https://github.com/yaboijbigs/under-review/actions/runs/35640359367) |

These older staging digests are retained for rollback and must not be confused with the first public deployment above or later image candidates:

- Web: `ghcr.io/yaboijbigs/under-review-web@sha256:26e2939692079f85fc6e71c8a57e6a5683713da6ab9ec7730c43534635120784`.
- Worker: `ghcr.io/yaboijbigs/under-review-worker@sha256:9bb5326dfe3cda816790cc8828552f056bcb76c5e0893abfe4dcaf7eaef03c31`.

The historical full runtime build restored the pinned R dependency lock from a fresh CI environment, ran the R checks, built both images, and pushed them. The subsequent staging web build included the runtime-configuration fix. All dependency compilation and model training occurred off the shared VPS. Later source or documentation commits do not by themselves change a deployed runtime.

To resolve a future release's public images, use full verified source commits:

```sh
node scripts/prepare-deployment.mjs --web-ref WEB_COMMIT_40_HEX --worker-ref WORKER_COMMIT_40_HEX
```

This updates only image references in the existing ignored `deploy/private/staging.env` and writes a public digest record. It requires that private deployment configuration already exist and that both images be anonymously retrievable.

## Historical executed staging verification

- All 56 TypeScript unit/integration tests passed, including real PostgreSQL tests in temporary isolated schemas. Coverage includes revision/draft idempotency, corrected-source history, concurrent game jobs, expired leases, review evidence, authorization, and safe publishing recovery. X transport was mocked throughout.
- TypeScript checks and the production Next.js build passed. Twelve desktop/mobile browser tests covered the real report, evidence links, layout, authenticated administration, CSRF forms, logout protection, attribution, and private indexing behavior. Both private/public runtime modes and alternate branding were checked using the same built artifact.
- Fifty R assertions and additional JSON/model-contract checks passed. Chronological baseline fitting used 2015–2022 training, 2023 calibration, and 2024–2025 holdout. The coaching promotion gate passed ten recorded diagnostics; limitations and measured results remain in [analytics/VALIDATION.md](analytics/VALIDATION.md).
- The real `2023_01_DET_KC` historical game completed both clean and raw source paths: 179 plays and 57 metric records, with matching modeled values/statuses. The real `2026_01_NE_SEA` current-season game supplied 166 play-by-play rows and 161 joined FTN rows, reconciled the 10–13 final score, and produced 70 metric records. Counts include unsupported/experimental records and do not represent proven officiating errors.
- Identical current-season input reused the existing report revision and draft. Integration tests separately verified preservation of older revisions after corrections and protection against duplicate publication jobs.
- A local copy of the isolated staging configuration completed bootstrap, both seed reports and dry-run drafts, eight web-route checks, and Linux-container administrator login/logout. The real report's share image returned HTTP 200 with valid PNG output.
- The project-scoped backup script produced and verified a PostgreSQL dump and artifact archive, restored into a unique temporary database, matched table counts and migration checksums, removed only that temporary database, and resumed only its selected local worker. See [OPERATIONS.md](OPERATIONS.md) for exact results and commands. This is a verified local backup/restore procedure; it does not claim automated off-host VPS backups.

## Historical Hostinger staging deployment

The additional `under-review` Docker project was created through the official Hostinger API. Deployment action `115884701` completed successfully at **2026-09-21 18:51:18 UTC**. Bootstrap exited successfully; database, web, and worker became healthy, using the image digests recorded above.

Only the web port is published, on **127.0.0.1:4380**. PostgreSQL has no host binding. The project has its own network, database, artifact volume, credentials, and bounded logs. Steady-state limits are worker **0.25 CPU / 1536 MiB**, web **0.10 CPU / 512 MiB**, and database **0.15 CPU / 512 MiB**, with low CPU shares, one analysis worker, and one R/BLAS thread. The manifest reserves 5 GiB of free disk before accepting more work. Broad historical training/backfills are prohibited on this deployment.

The historical seed job (`2023_01_DET_KC`) ran from **18:50:47.532 UTC to 19:00:52.910 UTC**, completing revision 1 with **57 metric records and one dry-run draft** in **10 minutes 5 seconds**. The current-season seed (`2026_01_NE_SEA`) ran from **19:00:52.979 UTC to 19:14:20.478 UTC**, completing revision 1 with **70 metric records and one dry-run draft** in **13 minutes 27 seconds**. These measured cold-run times are longer than local verification; the shared-VPS CPU limits remain in place. Games are processed sequentially, so a completed-game backlog adds queue time.

At **19:14:42.871 UTC**, the deployed one-shot check verified both reports and drafts, fetched both game pages successfully, and recorded HTTP **200** for `/`, `/methodology`, `/sources`, `/corrections`, `/status`, `/api/health`, `/api/ready`, and `/robots.txt`. It confirmed private staging, draft-only publishing, enabled kill switch, and disabled live posting. The **19:15:48 UTC** project inventory confirmed the check and bootstrap had both exited **0**, with web, database, and worker healthy. The normal scheduler continued processing newly queued 2026 games afterward; verification did not require draining that backlog.

The largest observed container-memory samples during verification were worker **1,054.72 / 1,536 MiB**, web **107.50 / 512 MiB**, database **54.93 / 512 MiB**, and check **69.16 / 192 MiB**. Hostinger reported a sampled worker CPU peak of **16.78%**. These are periodic container samples, not continuous maxima or a fresh measurement of aggregate VPS headroom.

The final before/after comparison at **19:15:48 UTC** covered **nine pre-existing projects and 30 containers**. Container IDs, images, published ports, and running/stopped states were unchanged. One existing container's intermittent healthy/unhealthy status was observed both before and after deployment; it was not restarted or modified. No existing project, reverse-proxy route, firewall rule, or shared listener was changed. This confirms container-level continuity; it is not an end-user functional test of every unrelated application.

## Operator actions and explicit limits

The first public release is accessible at **[underreview.jbigs.com](https://underreview.jbigs.com)**. Private credentials remain in ignored deployment files; do not copy them into release notes or command arguments. Loopback access through an SSH port forward remains available, but authenticated browser use should use the canonical HTTPS origin because its session cookies are Secure and origin checks are exact.

Live X posting remains disabled, draft-only mode and the kill switch remain enabled, and no real social post was sent. Live OAuth/delivery needs the operator's X developer application, supported paid access, account authorization, and explicit authenticated activation. [DATA_SOURCES.md](DATA_SOURCES.md) and [OPERATIONS.md](OPERATIONS.md) document setup and ambiguous-outcome recovery.

Overall anomaly percentile remains unavailable. Only compatible, adequately supported category comparisons are shown. Automatic call alternatives cover a limited allowlist; human review and approval establish call judgments. Unsupported overtime/complex counterfactuals, recovery/kicking WP effects, clock-management/two-point/onside models, comprehensive missed-call detection, and betting-integrity detection are not presented as implemented. Third-party model training cutoff provenance is incomplete, so retrospective coaching checks are not claimed to be leakage-free or causal validation of unchosen actions.

Arrange encrypted off-host backups and retention before relying on long-term hosted data. The public tunnel is deployed; live publishing remains a separate operator decision. No unrelated VPS project requires changes to run this application.

The backup subprocess deadline also covers stalled input/output streams. Focused checks verified an 8 MiB blocked input timed out in 1.59 seconds with a 1.5-second test deadline, terminated the parent and descendant processes, and reached the worker-resume cleanup. An 8 MiB binary round trip retained its SHA-256 hash, and a child failure did not expose its synthetic stderr secret. These tests used isolated helper processes and a mocked resume operation, without touching Docker projects.

## Exact local startup

With Node.js 24, npm, Docker, and Compose installed, run from a fresh checkout:

```sh
npm ci
npm run local:init
docker build -f analytics/Dockerfile -t under-review-analytics:local .
docker compose up --build -d
docker compose run --rm worker npm run ur -- doctor
```

Open http://localhost:4380. No paid credentials are needed locally. Administrator setup, real-game analysis, drafts, season sync, safe backfill, calibration, and correction commands are in [README.md](README.md).
