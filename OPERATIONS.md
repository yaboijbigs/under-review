# Under Review operations

This runbook covers the application and its own resources. The shared Hostinger deployment is VPS **1259888**, project **under-review**, serving **[underreview.jbigs.com](https://underreview.jbigs.com)**. Existing projects, databases, networks, unrelated routes, and global firewall settings are outside this application's deployment scope.

## Local configuration and checks

Run `npm ci`, `npm run local:init`, then build the pinned R base with `docker build -f analytics/Dockerfile -t under-review-analytics:local .` before `docker compose up --build -d`. The worker Dockerfile depends on that local base image. The local Compose project binds the website to `127.0.0.1:4380` and PostgreSQL to `127.0.0.1:5439`. The hosted website uses its dedicated tunnel; do not expose PostgreSQL on the VPS.

Useful project-scoped checks:

```sh
docker compose ps
docker compose logs --tail=100 web worker migrate
docker compose run --rm worker npm run ur -- doctor
docker compose run --rm worker npm run ur -- migrate
```

Web health endpoints are `/api/health` and `/api/ready`; `/status` reports source freshness, worker heartbeat, job counts, and publishing state. Health is process liveness; readiness depends on the database. The website must remain informative when an optional source, R model, or X connection fails.

The worker processes one job at a time and uses persistent PostgreSQL leases. It renews its lease every 15 seconds; an expired lease can be reclaimed. Failed jobs are visible in administration with retry state. Investigate a repeatedly failing source/model before reanalysis; do not erase failed-job evidence. Source fetches retain immutable checksummed bytes in the artifact volume.

Configuration belongs in ignored `.env` locally or the Hostinger project's private environment configuration. `TARGET_SEASON=2026` is the initial filter; season/week come from schedules. `SITE_URL` must match the actual intended origin. Set `VPS_STAGING=true` on the shared VPS to prohibit training and guard bulk processing. Leave `PRIVATE_STAGING=true` and `LIVE_POSTING_ALLOWED=false` during development/staging. Branding is configured with `BRAND_NAME` and `BRAND_TAGLINE`.

## Isolated shared-VPS release

The Hostinger deployment path, public-image availability, and external route require successful verification before they are reported operational. Use Hostinger's Docker-project deployment API for **under-review** on VPS **1259888** only. The release record must include the actual API result and subsequent health checks; code preparation alone is not a deployment result.

### Public rollout — first deployment executed

[deploy/compose.public.yaml](deploy/compose.public.yaml) launched **https://underreview.jbigs.com** with user approval. Hostinger action **115905298** succeeded at **2026-09-22 01:15:15 UTC**. Replacement action **115908663** succeeded at **02:17:20 UTC** after backup, import, and web checks. The independent coverage gate passed at **02:19:57.055**: 32 scheduled games, 31 completed and audited, no missing audits, Giants–Rams awaiting final data. Public desktop/mobile/authentication and sitemap checks passed; all 31 completed-game reports and audits were verified in the browser by **02:25:16.568**. [RELEASE.md](RELEASE.md) records both releases separately.

The dedicated tunnel's only application route is `underreview.jbigs.com` to **`http://web:3000`** on the Under Review private Docker network. Preserve the existing `jbigs.com` apex and `www.jbigs.com` routes. The application retains its own `127.0.0.1:4380` web binding; PostgreSQL and tunnel metrics have no host binding. Do not change shared ports 80/443, existing proxy listeners, unrelated tunnels, DNS records, or firewall rules. The tunnel token stays in the project's private environment configuration and out of logs, source, and release notes.

Before submitting Compose text to Hostinger, generate the compact manifest:

```sh
node scripts/compact-hostinger-compose.mjs deploy/compose.public.yaml deploy/private/compose.compact.yaml
```

Hostinger rejected the 9,775-character source manifest against its 8,192-character limit; that request applied no changes. The helper reproduces the accepted **8,187-character** form, minifies only the three inline JavaScript commands, checks their syntax, and compares parsed Compose settings without interpolating secrets. It needs installed Node dependencies and Docker Compose, not a running Docker daemon or deployment credentials. Submit the generated file with the existing private environment values; retain the readable source manifest in Git and regenerate after changes.

The current manifest's project-scoped upgrade sequence is below. The second deployment has completed import and reopened the website; its independent coverage check is still running:

1. Record the existing Under Review manifest, private configuration, image digests, and unrelated-project baseline. Stop **only the existing `under-review` project**, preserving its named database and artifact volumes. Confirm its old worker and web cannot mutate data during backup; do not stop other projects or remove volumes.
2. Start the replacement manifest's dedicated database and one-shot `backup` service against those same persistent volumes. The backup writes `/data/backups/<UTC timestamp>-public-launch/` on **Under Review's own artifact volume**: a custom-format PostgreSQL `database.dump`, its `pg_restore --list` catalog, a gzip archive of `/data/snapshots`, and SHA-256 checksums. The dump catalog must be readable and the archive must pass `gzip -t`. This is a same-host capture with integrity checks, **not a restore test or an off-host backup**. A failed backup prevents bootstrap and the public route from starting; preserve its output for investigation.
3. After backup succeeds, bootstrap applies application setup and syncs 2026. It idempotently ensures the GB seed job with key `release:game-audit-v1:2026_02_GB_NYJ`, `backfill: true`, `preferRaw: false`, and `prepareDraft: true`. A previously successful job with that same key is retained; redeployment does **not** require a fresh GB R run. The web can start after bootstrap.
4. The one-shot `import` service uses `CATCHUP_IMAGE` to validate/import the local public-source bundles under `/imports`, prepare dry-run drafts, and queue remaining bounded audit work. It preserves conflicting existing reports for normal reconciliation. The single worker starts only after **both bootstrap and import succeed**, preventing analysis/import races.
5. Once web and worker are healthy, `check` waits up to 30 minutes for the GB current revision's complete winning profile, checksummed historical-outlier audit, supported metric, current-revision draft, and successful web routes. Separately, `coverage` waits up to one hour for all 32 Week 1–2 schedule records, at least 31 scored games, and the current audit version on every scored game's report. It polls once per minute; this proves audit presence, not that every optional field/model is supported. Inspect missing-data states separately.
6. The tunnel starts **only after** the web is healthy and `check` exits successfully. The independent `coverage` result is **not** a tunnel dependency, so public availability does not establish completed catch-up. Verify coverage completion, public HTTPS, the exact hostname, protected administration, readiness, and the unchanged unrelated-project baseline before reporting the upgrade complete. The GB check is a known-case release fixture, not independent statistical validation.

The public manifest retains worker **0.25 CPU / 1536 MiB**, web **0.10 CPU / 512 MiB**, and database **0.15 CPU / 512 MiB** caps. It also limits backup/check to **0.10 CPU / 192 MiB** each, bootstrap to **0.25 CPU / 512 MiB**, and the tunnel to **0.05 CPU / 128 MiB**. One worker, one R/BLAS thread, bounded logs/PIDs, a 15-minute analytics deadline, and a 5 GiB free-disk reserve remain configured. `SITE_URL=https://underreview.jbigs.com` and `PRIVATE_STAGING=false` enable the canonical public origin/indexing; `VPS_STAGING=true` retains bulk-work restrictions. Only the tunnel-facing web service enables `TRUST_CLOUDFLARE_CLIENT_IP=true`, which requires no public bypass to that container. **Live posting stays disabled, draft-only mode remains selected, and the kill switch stays enabled.** Public website access does not authorize social posting.

The upgrade additionally caps `import` at **0.25 CPU / 1024 MiB** and `coverage` at **0.05 CPU / 128 MiB**. Both are one-shot services with bounded logs and no host ports; import finishes before the worker begins processing.

1. Record existing project/container names, their published ports and health, current reverse-proxy routes, available memory/disk, and host load. Reserve an unused loopback web port; the local default is 4380, subject to the host inventory.
2. Build the web and worker/R images on the development/build machine. Run tests there, push to the user-authorized **public GHCR repository**, and record immutable image digests. Verify the public source/image release contains the required code/data/model notices and no credentials, environment secrets, database exports, or local caches. Push and unauthenticated pull must be verified. Do not run Next.js dependency builds, R package compilation, historical training, or unbounded backfills on the shared VPS.
3. Deploy only an `under-review` project with unique private network, database credentials, volumes, environment, and image references. The deployed manifest uses image digests rather than local build directives. Do not copy the local loopback PostgreSQL binding into VPS deployment. Containers must not use host networking, privileged mode, or the Docker socket.
4. Proposed initial caps, subject to measured VPS headroom and single-game load testing: worker **0.25 CPU / 1536 MiB**, web **0.10 CPU / 512 MiB**, database **0.15 CPU / 512 MiB**. Configure restart policies, bounded logs, PID limits, one worker, and one R/BLAS thread. Verify actual Compose/API enforcement. If the budget causes R failures, defer analysis or adjust only the approved project budget; do not remove limits or consume other projects' capacity.
5. Run one application migration job after the dedicated database becomes healthy, then start web and worker. Check worker heartbeat and one single-game analysis under the actual caps. A memory-killed or timed-out analysis remains a visible failed/deferred job; it is not a published successful report.
6. For public releases, use only the dedicated hostname/tunnel route and readiness gate above. Preserve existing listeners and routes. Do not replace the proxy, claim ports 80/443 already used elsewhere, or alter shared firewall rules. A private staging release remains non-indexable; neither mode enables X posting by itself.
7. Recheck the same pre-existing project routes and health, then verify the new website, authenticated admin, readiness, persistence, jobs, report revision, and dry-run draft. Record results and resource usage. If other projects regress, stop/roll back only Under Review.

Use project-qualified commands (`docker compose -p under-review ...`) and the correct manifest/environment. Never use `docker system prune`, global container stop/remove commands, or deletion of an entire shared Docker/Hostinger directory. Stopping this project's services must preserve its named volumes.

## Backup, restore, and rollback

Back up the dedicated Under Review database and artifact volume together with encrypted private configuration and the release's image digests. Database dumps should use PostgreSQL's supported dump tool; copy source snapshots and model artifacts without rewriting their bytes. Retain their manifests and checksums. Keep backup copies outside the active database volume and confirm that a project-only restore works in an isolated environment.

The executable [scripts/backup.ps1](scripts/backup.ps1) requires PowerShell 7 and Docker Compose. It verifies the selected database/worker container labels and the project's `artifacts` volume, then writes a custom-format PostgreSQL dump, a gzip artifact archive, and a SHA-256 manifest into a unique directory under ignored `deploy/private/backups/`. Binary data is streamed without PowerShell text redirection. It never exports environment values, removes existing backups, stops other services, or operates on other projects.

Run from the repository root against the local verification stack:

```powershell
pwsh -NoProfile -File scripts/backup.ps1 `
  -ProjectName under-review-staging-check `
  -ComposeFile deploy/private/local-staging.yaml `
  -EnvFile deploy/private/staging.env `
  -PauseWorker -VerifyRestore
```

For the ordinary local stack, the defaults are `-ProjectName under-review -ComposeFile compose.yaml -EnvFile .env`. Relative file arguments resolve against the repository root; absolute paths also work. `-PauseWorker` gives the worker its SIGTERM grace period, stops only that worker, and restarts it in `finally`; a worker already stopped remains stopped. `-WorkerStopTimeoutSeconds` defaults to 300 (allowed 30–900). The script confirms the worker stopped and waits for any live lease to expire before capture. Interrupted jobs remain in the dump for ordinary durable recovery and their count is recorded in the manifest; no job rows are deleted or falsely marked successful. If a live lease does not expire within the additional wait, the backup aborts and the worker resumes. Avoid administrative mutations during the brief backup window; the website and database stay running.

`-VerifyRestore` creates a randomly named `ur_restore_test_<32 hex digits>` database in the selected project's PostgreSQL container, streams the dump into it, and compares core table counts and migration checksums with the source. It drops only that exact newly created database after checking its prefix, including on failure. This option needs the configured database role to have database-creation permission. It never overwrites the application database. The artifact archive is checked with `gzip -t`; both output files receive byte counts and SHA-256 hashes. A failed run preserves its partial directory for investigation; only a completed run emits its success record.

Each Docker subprocess has a one-hour deadline covering input copying, process execution, and output draining. A stalled stream triggers process-tree termination and returns control to cleanup, including resuming the selected worker. Focused timeout, descendant-cleanup, binary-integrity, and secret-suppression checks passed after the full backup/restore verification.

Backups contain application records and encrypted OAuth tokens, so keep them private and encrypt off-host copies. The script deliberately does not export environment secrets or proxy configuration; preserve those separately in encrypted storage together with the token-encryption key and image digests. No retention deletion or automatic restoration is performed.

Verified on 2026-09-21 against **only** the local `under-review-staging-check` stack: the script wrote a 576,605-byte database dump and 1,188,429-byte artifact archive, validated the gzip stream, and restored the dump into a unique temporary database. Verification matched 557 games, 514 plays, 249 events, 3 revisions, 7 snapshots, 3 publications, 1 user, and all three migration checksums. One interrupted job remained preserved for recovery. The test database was removed; database, web, and resumed worker were healthy afterward. The generated manifest and SHA-256 hashes remain under ignored `deploy/private/backups/20260921T184250Z-3dadd468a37f42e890fd6c774be425ad/`.

The public-launch VPS capture completed at **2026-09-22 01:06:36 UTC**, under `/data/backups/20260922T010533Z-public-launch` on the artifact volume, with dump-catalog, gzip, and checksum checks. This executed same-host capture is separate from the local restore test. Encrypted off-host storage and retention remain outstanding.

The second deployment's capture completed at **02:10:03.586 UTC**, under `/data/backups/20260922T020904Z-public-launch`, before import began. It remains a same-host capture, not a restore test or off-host backup.

Backups cover **only** Under Review's PostgreSQL database/user, artifact volume, private configuration, and proxy route. Do not export another application's database or change a host-wide backup policy. Maintain an application-specific retention schedule and monitor free space. The worker defaults to a 1 GiB free-disk reserve (`MIN_FREE_DISK_BYTES`) and defers work below it.

Before each release, capture the current image digests, project manifest/environment, schema migration checksums, and proxy snippet; take a fresh application-only backup. Apply additive compatible migrations where possible. A normal rollback restores the preceding Under Review image digests and configuration while retaining its data volumes. Validate readiness and existing-project health afterward.

A database restore is a separate, explicit recovery operation: stop this project's worker/web, preserve a forensic copy of current data, restore the selected Under Review backup into its dedicated database, restore matching artifacts/configuration, and then restart only this project. Restoring an old backup can discard newer reports, reviews, jobs, or publication state. Do not infer that an external X post disappears when its local database row is restored; reconcile externally before allowing publication again. Never run an automatic destructive down-migration or overwrite a shared database.

## Data corrections and analytics recovery

### Bounded Weeks 1–2 catch-up — verified

The user authorized completed **2026 regular-season Weeks 1 and 2**, plus automatic analysis after tonight's `2026_02_NYG_LA` finishes. The upgraded worker contains the commands below; they were absent from the first public image. Do not substitute a whole-season historical backfill.

```sh
npm run ur -- coverage --season 2026 --weeks 1,2
npm run ur -- catch-up --season 2026 --weeks 1,2
npm run ur -- export-analysis --game GAME_ID --output /exports/GAME_ID.json
npm run ur -- import-analysis --input /imports/GAME_ID.json
```

Run commands inside the intended worker runtime with paths mounted there. `coverage` reads the stored schedule, latest revisions/audit versions, and pending/running/failed jobs. `catch-up` refreshes the schedule, accepts only one or two explicit regular-season weeks, and queues clean backfill for missing reports or an audit-only refresh for existing reports. It skips future/unscored games and current audits; existing R findings and old revisions remain preserved. A queued job is not completed coverage.

Compute missing R analyses locally using the same pinned code/models, then export public-source-only bundles. Each bundle is bounded to 64 MiB, contains checksummed public source bytes plus automated report output, and excludes accounts, sessions, manual reviews, and publishing state. Import verifies source identities/bytes, finality, exact code/model/configuration fingerprints, and recomputed game-audit evidence. It rejects conflicting destination reports and prevents automatic publication; it is not a database restore. Keep private environment files and operational database exports out of the transfer artifact.

The import completed at **02:16:20.055 UTC**: ten new reports were imported, the existing `2026_02_IND_KC` report was preserved, and 17 older audits were refreshed by **02:18:58.863**. The coverage service exited successfully after confirming all 31 completed games had current audits at **02:19:57.055**. Public verification also passed all 16 Week 1 and 15 completed Week 2 reports. The scheduler prioritizes schedule discovery and newly finished games while retaining per-game locks and retries. Near games, schedule discovery runs in five-minute buckets between bounded analysis jobs; processing still depends on validated final provider data. Giants–Rams remained unscored at verification and will be discovered automatically. TB–CIN's conflicting aggregate score is labeled as a source limitation; its unsupported team profiles remain withheld while its play-by-play report is available.

For one game, refresh and reconcile clean data:

```sh
docker compose run --rm worker npm run ur -- sync-season --season 2026
docker compose run --rm worker npm run ur -- analyze-game --game 2026_01_NE_SEA --clean
```

Use `--backfill` for a historical investigation that must not trigger automatic publication. `backfill --season YEAR` and `reconcile --season YEAR` perform sequential clean processing without automatic social posts; run broad operations off the VPS. Keep source and model versions with the analysis. A new input creates a new revision and change summary; never edit an old published revision in place to conceal corrections.

A new raw-source revision is **preliminary**, including when its metric values match an earlier clean revision: its unmodeled fields have not inherited clean-source validation. Source-linked metric records can change while the number of changed statistical findings is zero. Preserve both revisions and use the explicit clean reconciliation path when a reconciled current report is required.

When a source is unavailable, review the reason code and actual freshness. Missing FTN data is unavailable, not zero mistakes. Raw-PBP failure may fall back to clean releases; neither source publishes without terminal/completeness checks. Repeated checksum mismatch indicates damaged local bytes and requires recovery from a verified backup or an explicitly retrieved new snapshot. Preserve the failed source metadata for investigation.

When R is unavailable, verify the worker image and pinned runtime (`RSCRIPT_BIN`, if overridden). The bridge uses fixed subprocess arguments, bounded input/output, a configured timeout, and a structured error contract. Train/evaluate models on the build machine using [analytics/README.md](analytics/README.md), inspect diagnostics, and transfer only approved checksummed artifacts. Do not promote experimental coaching or overall-percentile results to hide missing coverage.

## X account setup and publication incidents

The official requirements and URLs are listed in [DATA_SOURCES.md](DATA_SOURCES.md). The operator needs an X developer application with appropriate paid API access; setup does not purchase anything. Configure a confidential web application, exact callback URI, OAuth 2.0 authorization code with PKCE S256, and `tweet.read tweet.write users.read offline.access` scopes. Set `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, and a persistent 32-byte hex `TOKEN_ENCRYPTION_KEY` on the server. Encrypted tokens cannot be recovered if that key is lost.

Connect the intended account through authenticated administration. Keep draft-only mode and the kill switch enabled until an operator deliberately enables live deployment settings, selects that account, activates automatic mode, and disables the kill switch. Initial posts are restricted to eligible newly completed games; backfills do not flood the account. Material corrections/updates require explicit approval. Verify the exact report URL is reachable before publishing.

For API 429 responses, respect the provider reset time and inspect the persistent retry record. An explicit HTTP 401 rejection triggers at most one token refresh and a separately queued attempt; a second 401 or failed refresh stops automatic submission and requires account reconnection. An ambiguous timeout, interrupted submission, 408/5xx response, or successful HTTP response without a verified post ID becomes **unknown outcome** and never enters that retry path.

For an unknown outcome, an administrator has two reconciliation choices: supply the existing numeric X post ID, or permanently cancel further submission. The supported GET API must confirm the intended author and exact full text, expanding X's URL entities to verify the original report-revision URL. A successful match marks the outbox published with an audit record. A missing/deleted/inaccessible post leaves the outcome unknown; absence is never permission to resend. Cancellation preserves the uncertainty and never queues a replacement. Do not delete the outbox row or blindly rerun the POST. Use the kill switch first during an unexpected-publication incident.

No test, credential check, or deployment readiness check should submit a real X post. Live API delivery and OAuth authorization must be distinguished from mocked publishing tests and dry-run drafts in the release report.

## Verified checks and release record

Source validation tests have passed against the attributable 2023/2026 fixtures. A live TypeScript source-adapter check on 2026-09-21 fetched `2026_01_NE_SEA`: 166 PBP rows, 161 joined FTN rows, reconciled 10–13 score, and no join conflicts or unmatched charting records. This check did not claim R analysis or X delivery.

The public source repository is [yaboijbigs/under-review](https://github.com/yaboijbigs/under-review). The initial public push followed a scan of 141 release files for secrets; subsequent releases are scanned again before pushing. Public web and worker images are built in GitHub Actions and verified through anonymous registry manifest requests. The first executed public release used web source `4bbc02dfb186e633f62f0e8cd83d34d18158d487` and worker source `4d4da0ae0ef19bde46bec12c0298ae6bc3f3bff6`; [RELEASE.md](RELEASE.md) retains their deployed immutable digests. Later updates to [deploy/images.json](deploy/images.json) identify verified artifacts but do not by themselves establish deployment.

The isolated PostgreSQL integration suites have passed revision/draft idempotency, old-score preservation after correction, concurrent same-game job exclusion, expired-lease recovery, retained manual review evidence, disabled default live posting, exact-post reconciliation, permanent cancellation, bounded 401 refresh, and no retry of ambiguous outcomes. Run them with `RUN_DB_TESTS=1 npx vitest run tests/database.integration.test.ts tests/publishing.integration.test.ts`. X transport is mocked; no test sends a real post.

Local container analysis completed for `2023_01_DET_KC` (57 metric records) and `2026_01_NE_SEA` (70 metric records, clean source). The historical game also passed the full raw-source worker path after pinning gsisdecoder: 179 plays, a new attributable revision, no fallback warning, and identical metric values/statuses/model versions to its clean-source report. A repeated current-season clean analysis reused the same revision/input hash. These record counts include coverage/status distinctions and are not counts of proven errors. Chronological baseline training used 2015–2022, calibration 2023, and holdout 2024–2025; the recorded coaching gate passed its ten diagnostics. Model limitations, including the unknown upstream training cutoff and sensitive/out-of-domain states, remain visible.

The executed staging, first public release, and completed coverage upgrade are recorded separately in [RELEASE.md](RELEASE.md). Local and VPS checks remain distinguished. Live X posting remains intentionally untested and disabled; the verified local restore procedure and executed same-host VPS capture do not replace an encrypted off-host backup schedule.
