# Under Review operations

This runbook covers the application and its own resources. The intended shared Hostinger target is VPS **1259888**, as the additional project **under-review**. Existing projects, databases, networks, reverse-proxy routes, and global firewall settings are outside this application's deployment scope.

## Local configuration and checks

Run `npm ci`, `npm run local:init`, then build the pinned R base with `docker build -f analytics/Dockerfile -t under-review-analytics:local .` before `docker compose up --build -d`. The worker Dockerfile depends on that local base image. The local Compose project binds the website to `127.0.0.1:4380` and PostgreSQL to `127.0.0.1:5439`; only the website needs a public route in a later authorized deployment. Do not expose PostgreSQL on the VPS.

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

1. Record existing project/container names, their published ports and health, current reverse-proxy routes, available memory/disk, and host load. Reserve an unused loopback web port; the local default is 4380, subject to the host inventory.
2. Build the web and worker/R images on the development/build machine. Run tests there, push to the user-authorized **public GHCR repository**, and record immutable image digests. Verify the public source/image release contains the required code/data/model notices and no credentials, environment secrets, database exports, or local caches. Push and unauthenticated pull must be verified. Do not run Next.js dependency builds, R package compilation, historical training, or unbounded backfills on the shared VPS.
3. Deploy only an `under-review` project with unique private network, database credentials, volumes, environment, and image references. The deployed manifest uses image digests rather than local build directives. Do not copy the local loopback PostgreSQL binding into VPS deployment. Containers must not use host networking, privileged mode, or the Docker socket.
4. Proposed initial caps, subject to measured VPS headroom and single-game load testing: worker **0.25 CPU / 1536 MiB**, web **0.10 CPU / 512 MiB**, database **0.15 CPU / 512 MiB**. Configure restart policies, bounded logs, PID limits, one worker, and one R/BLAS thread. Verify actual Compose/API enforcement. If the budget causes R failures, defer analysis or adjust only the approved project budget; do not remove limits or consume other projects' capacity.
5. Run one application migration job after the dedicated database becomes healthy, then start web and worker. Check worker heartbeat and one single-game analysis under the actual caps. A memory-killed or timed-out analysis remains a visible failed/deferred job; it is not a published successful report.
6. Add only the intended hostname route through the existing reverse proxy after validating its configuration. Preserve other listeners and routes. Do not replace the proxy, claim ports 80/443 already used elsewhere, or alter shared firewall rules as a shortcut. Private staging remains non-indexable and does not post to X.
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

Verified on 2026-09-21 against **only** the local `under-review-staging-check` stack: the script wrote a 576,605-byte database dump and 1,188,429-byte artifact archive, validated the gzip stream, and restored the dump into a unique temporary database. Verification matched 557 games, 514 plays, 249 events, 3 revisions, 7 snapshots, 3 publications, 1 user, and all three migration checksums. One interrupted job remained preserved for recovery. The test database was removed; database, web, and resumed worker were healthy afterward. The generated manifest and SHA-256 hashes remain under ignored `deploy/private/backups/20260921T184250Z-3dadd468a37f42e890fd6c774be425ad/`. This verifies the local procedure; VPS backup execution, encrypted off-host storage, and retention remain separate operational checks.

Backups cover **only** Under Review's PostgreSQL database/user, artifact volume, private configuration, and proxy route. Do not export another application's database or change a host-wide backup policy. Maintain an application-specific retention schedule and monitor free space. The worker defaults to a 1 GiB free-disk reserve (`MIN_FREE_DISK_BYTES`) and defers work below it.

Before each release, capture the current image digests, project manifest/environment, schema migration checksums, and proxy snippet; take a fresh application-only backup. Apply additive compatible migrations where possible. A normal rollback restores the preceding Under Review image digests and configuration while retaining its data volumes. Validate readiness and existing-project health afterward.

A database restore is a separate, explicit recovery operation: stop this project's worker/web, preserve a forensic copy of current data, restore the selected Under Review backup into its dedicated database, restore matching artifacts/configuration, and then restart only this project. Restoring an old backup can discard newer reports, reviews, jobs, or publication state. Do not infer that an external X post disappears when its local database row is restored; reconcile externally before allowing publication again. Never run an automatic destructive down-migration or overwrite a shared database.

## Data corrections and analytics recovery

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

The public source repository is [yaboijbigs/under-review](https://github.com/yaboijbigs/under-review). The initial public push followed a scan of 141 release files for secrets; subsequent releases are scanned again before pushing. Public web and worker images were built in GitHub Actions, verified through anonymous registry manifest requests, and deployed by immutable digest. [deploy/images.json](deploy/images.json) records their actual source revisions and digests.

The isolated PostgreSQL integration suites have passed revision/draft idempotency, old-score preservation after correction, concurrent same-game job exclusion, expired-lease recovery, retained manual review evidence, disabled default live posting, exact-post reconciliation, permanent cancellation, bounded 401 refresh, and no retry of ambiguous outcomes. Run them with `RUN_DB_TESTS=1 npx vitest run tests/database.integration.test.ts tests/publishing.integration.test.ts`. X transport is mocked; no test sends a real post.

Local container analysis completed for `2023_01_DET_KC` (57 metric records) and `2026_01_NE_SEA` (70 metric records, clean source). The historical game also passed the full raw-source worker path after pinning gsisdecoder: 179 plays, a new attributable revision, no fallback warning, and identical metric values/statuses/model versions to its clean-source report. A repeated current-season clean analysis reused the same revision/input hash. These record counts include coverage/status distinctions and are not counts of proven errors. Chronological baseline training used 2015–2022, calibration 2023, and holdout 2024–2025; the recorded coaching gate passed its ten diagnostics. Model limitations, including the unknown upstream training cutoff and sensitive/out-of-domain states, remain visible.

The executed release evidence is recorded in [RELEASE.md](RELEASE.md): full container startup, R/model checks, desktop/mobile browser results, public image publication and retrieval, Hostinger action/health, and comparison of the existing projects. Local and VPS checks are identified separately. Live X posting remains intentionally untested and disabled; the verified backup/restore procedure still needs an encrypted off-host VPS backup schedule.
