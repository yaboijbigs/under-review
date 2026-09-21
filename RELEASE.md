# Under Review release — 2026-09-21

The MIT-licensed application source is public at [yaboijbigs/under-review](https://github.com/yaboijbigs/under-review). The web and worker images are public, and anonymous registry manifest requests verified both immutable digests before deployment. Private environment files, administrator credentials, database exports, backups, and caches are excluded from Git and image build contexts. The staged release is scanned for credential patterns and exact local secrets before publishing.

## Reproducible artifacts

| Component | Source revision | Build |
| --- | --- | --- |
| Worker, R runtime, and model artifacts | `208bbf402b8ee2422dc0edb70676a718c8c236e3` | [Successful full runtime build](https://github.com/yaboijbigs/under-review/actions/runs/35639017767) |
| Web, including runtime branding/indexing configuration | `03818639368b1e4d140d5d2334da0efb3dffd2bc` | [Successful web build](https://github.com/yaboijbigs/under-review/actions/runs/35640359367) |

[deploy/images.json](deploy/images.json) records the complete image digests. Subsequent documentation commits do not change these deployed runtime revisions. The full runtime build restored the pinned R dependency lock from a fresh CI environment, ran the R checks, built both images, and pushed them. The final web build included the runtime-configuration fix. All dependency compilation and model training occurred off the shared VPS.

To resolve a future release's public images, use full verified source commits:

```sh
node scripts/prepare-deployment.mjs --web-ref WEB_COMMIT_40_HEX --worker-ref WORKER_COMMIT_40_HEX
```

This updates only image references in the existing ignored `deploy/private/staging.env` and writes a public digest record. It requires that private deployment configuration already exist and that both images be anonymously retrievable.

## Executed verification

- All 56 TypeScript unit/integration tests passed, including real PostgreSQL tests in temporary isolated schemas. Coverage includes revision/draft idempotency, corrected-source history, concurrent game jobs, expired leases, review evidence, authorization, and safe publishing recovery. X transport was mocked throughout.
- TypeScript checks and the production Next.js build passed. Twelve desktop/mobile browser tests covered the real report, evidence links, layout, authenticated administration, CSRF forms, logout protection, attribution, and private indexing behavior. Both private/public runtime modes and alternate branding were checked using the same built artifact.
- Fifty R assertions and additional JSON/model-contract checks passed. Chronological baseline fitting used 2015–2022 training, 2023 calibration, and 2024–2025 holdout. The coaching promotion gate passed ten recorded diagnostics; limitations and measured results remain in [analytics/VALIDATION.md](analytics/VALIDATION.md).
- The real `2023_01_DET_KC` historical game completed both clean and raw source paths: 179 plays and 57 metric records, with matching modeled values/statuses. The real `2026_01_NE_SEA` current-season game supplied 166 play-by-play rows and 161 joined FTN rows, reconciled the 10–13 final score, and produced 70 metric records. Counts include unsupported/experimental records and do not represent proven officiating errors.
- Identical current-season input reused the existing report revision and draft. Integration tests separately verified preservation of older revisions after corrections and protection against duplicate publication jobs.
- A local copy of the isolated staging configuration completed bootstrap, both seed reports and dry-run drafts, eight web-route checks, and Linux-container administrator login/logout. The real report's share image returned HTTP 200 with valid PNG output.
- The project-scoped backup script produced and verified a PostgreSQL dump and artifact archive, restored into a unique temporary database, matched table counts and migration checksums, removed only that temporary database, and resumed only its selected local worker. See [OPERATIONS.md](OPERATIONS.md) for exact results and commands. This is a verified local backup/restore procedure; it does not claim automated off-host VPS backups.

## Hostinger staging deployment

The additional `under-review` Docker project was created through the official Hostinger API. Deployment action `115884701` completed successfully at **2026-09-21 18:51:18 UTC**. Bootstrap exited successfully; database, web, and worker became healthy, using the image digests recorded above.

Only the web port is published, on **127.0.0.1:4380**. PostgreSQL has no host binding. The project has its own network, database, artifact volume, credentials, and bounded logs. Steady-state limits are worker **0.25 CPU / 1536 MiB**, web **0.10 CPU / 512 MiB**, and database **0.15 CPU / 512 MiB**, with low CPU shares, one analysis worker, and one R/BLAS thread. The manifest reserves 5 GiB of free disk before accepting more work. Broad historical training/backfills are prohibited on this deployment.

The historical seed job (`2023_01_DET_KC`) ran from **18:50:47.532 UTC to 19:00:52.910 UTC**, completing revision 1 with **57 metric records and one dry-run draft** in **10 minutes 5 seconds**. The current-season seed (`2026_01_NE_SEA`) ran from **19:00:52.979 UTC to 19:14:20.478 UTC**, completing revision 1 with **70 metric records and one dry-run draft** in **13 minutes 27 seconds**. These measured cold-run times are longer than local verification; the shared-VPS CPU limits remain in place. Games are processed sequentially, so a completed-game backlog adds queue time.

At **19:14:42.871 UTC**, the deployed one-shot check verified both reports and drafts, fetched both game pages successfully, and recorded HTTP **200** for `/`, `/methodology`, `/sources`, `/corrections`, `/status`, `/api/health`, `/api/ready`, and `/robots.txt`. It confirmed private staging, draft-only publishing, enabled kill switch, and disabled live posting. The **19:15:48 UTC** project inventory confirmed the check and bootstrap had both exited **0**, with web, database, and worker healthy. The normal scheduler continued processing newly queued 2026 games afterward; verification did not require draining that backlog.

The largest observed container-memory samples during verification were worker **1,054.72 / 1,536 MiB**, web **107.50 / 512 MiB**, database **54.93 / 512 MiB**, and check **69.16 / 192 MiB**. Hostinger reported a sampled worker CPU peak of **16.78%**. These are periodic container samples, not continuous maxima or a fresh measurement of aggregate VPS headroom.

The final before/after comparison at **19:15:48 UTC** covered **nine pre-existing projects and 30 containers**. Container IDs, images, published ports, and running/stopped states were unchanged. One existing container's intermittent healthy/unhealthy status was observed both before and after deployment; it was not restarted or modified. No existing project, reverse-proxy route, firewall rule, or shared listener was changed. This confirms container-level continuity; it is not an end-user functional test of every unrelated application.

## Operator actions and explicit limits

The current website is private staging, independent of the public source/images. Local private access instructions and the generated administrator password are in ignored `deploy/private/access.txt`. Use an SSH port forward for access; stop any local preview already occupying port 4380 first. No domain has been purchased or attached.

Live X posting remains disabled, draft-only mode and the kill switch remain enabled, and no real social post was sent. Live OAuth/delivery needs the operator's X developer application, supported paid access, account authorization, and explicit authenticated activation. [DATA_SOURCES.md](DATA_SOURCES.md) and [OPERATIONS.md](OPERATIONS.md) document setup and ambiguous-outcome recovery.

Overall anomaly percentile remains unavailable. Only compatible, adequately supported category comparisons are shown. Automatic call alternatives cover a limited allowlist; human review and approval establish call judgments. Unsupported overtime/complex counterfactuals, recovery/kicking WP effects, clock-management/two-point/onside models, comprehensive missed-call detection, and betting-integrity detection are not presented as implemented. Third-party model training cutoff provenance is incomplete, so retrospective coaching checks are not claimed to be leakage-free or causal validation of unchosen actions.

Arrange encrypted off-host backups and retention before relying on long-term hosted data. A public hostname/TLS route and live publishing are separate operator decisions. No unrelated VPS project requires changes to run this application.

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
