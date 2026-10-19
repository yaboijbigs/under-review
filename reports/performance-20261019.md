Under Review's web update became healthy on **2026-10-19 at 16:23:40 UTC** on `srv1259888`, project `/docker/under-review`. Only the web container was recreated. The database and web retain **0.5 CPU** limits; other Under Review container IDs were unchanged. Database records and volumes were preserved. Every live change and its undo were appended to `/root/gordon-cpu-changes.log`.

The deployed application source is [`f87f63731c98c81b4859383c27d5c27ce290e0a2`](https://github.com/yaboijbigs/under-review/commit/f87f63731c98c81b4859383c27d5c27ce290e0a2), on branch [`perf/public-isr-hot-indexes-20261019`](https://github.com/yaboijbigs/under-review/tree/perf/public-isr-hot-indexes-20261019). Test correction [`55b403b32deda6b4f04cc4b497e8105ed53b654f`](https://github.com/yaboijbigs/under-review/commit/55b403b32deda6b4f04cc4b497e8105ed53b654f) accepts Next.js's streamed login redirect while still checking that unauthenticated responses contain no operator content or CSRF token. It changes no deployed application behavior.

Public game reports, historical revisions, the unfiltered homepage, methodology, sources, corrections, and report images now use on-demand ISR with 60-second revalidation. Existing `?revision=N` links select their own cached revision; archive filters retain their query behavior and share database results for 60 seconds. Admin, health, status, and visitor feedback retain their dynamic behavior. Runtime branding and staging/indexing settings are preserved by generating public pages on first request. Failed refreshes retain the last successful page instead of caching an error view.

The web container has a read-only root filesystem. ISR uses a bounded **32 MiB process-local cache**, with disk writes disabled. Eviction or restart requires regeneration. Next.js origin compression is disabled (`compress: false`); Cloudflare continues to front the public site. Requests advertising gzip/Brotli received no origin `Content-Encoding` header.

Two indexes were created with `CREATE INDEX CONCURRENTLY`, outside the transactional migration runner, and checked as valid and ready:

- `source_snapshots_provider_retrieved_at` on `source_snapshots(provider, retrieved_at DESC)`.
- `games_season_kickoff_at` on `games(season, kickoff_at) INCLUDE (id)`.

The report-source query now materializes its small JSON snapshot-ID array and uses `id = ANY(ARRAY(...))`, allowing probes through the existing `source_snapshots` primary key. Comparing the old and new source selections across **2,362 revisions found zero mismatches**. The application-only query change retains one database checkout and one consistent SQL snapshot per report. Ordinary `VACUUM (ANALYZE) source_snapshots` refreshed visibility/statistics; no games vacuum was performed.

The pre-migration PostgreSQL custom-format dump is `/docker/under-review/backups/20261019T155743Z-performance/database.dump` (200,150,547 bytes). Its `pg_restore --list` catalog was verified. This is a same-host backup; no restore test or off-host copy was performed for this deployment.

`EXPLAIN (ANALYZE, BUFFERS)` used normal planner settings. The observed plans were:

| Query | Before | After | Shared buffers before → after | Execution time before → after |
| --- | --- | --- | --- | --- |
| Current-season kickoff window | Sequential scan of 557 games | Index-only scan, `games_season_kickoff_at`, zero heap fetches | 154 → 2 | 0.390 → 0.186 ms |
| Latest source retrieval by provider | Sequential scan of 1,213 snapshots | Index-only scan, `source_snapshots_provider_retrieved_at`, zero heap fetches | 180 → 10 | 1.772 → 0.463 ms |
| Selected report's source snapshots | Sequential scan and hash semi-join | Bitmap index/heap scan through `source_snapshots_pkey` | 183 → 18 for the measured query | 1.133 → 0.463 ms |

These are individual plan observations, not query latency distributions. The kickoff window returned no matching rows in both observations; the provider query still reads every index entry to aggregate seven providers.

The request benchmark ran **20 sequential requests per route**, before and after, against `http://127.0.0.1:4380`. All 120 responses were HTTP 200. The baseline was collected after Ops had already raised both CPU caps to 0.5. The after sample followed initial cache warm-up. Values below are milliseconds; each pair is **median / maximum**.

| Route | Before TTFB | After TTFB | Before complete response | After complete response |
| --- | ---: | ---: | ---: | ---: |
| `/` | 8.532 / 1,058.367 | 11.449 / 25.292 | 326.147 / 1,242.313 | 12.500 / 26.722 |
| `/games/2026_06_DAL_GB` | 59.930 / 441.772 | 17.980 / 49.357 | 701.485 / 1,347.189 | 19.123 / 50.440 |
| `/api/health` | 3.300 / 13.906 | 5.139 / 7.094 | 3.710 / 14.037 | 5.411 / 7.501 |

Warm complete-response medians improved approximately 26× for the homepage and 37× for the game report. Baseline HTML streamed its initial bytes before completing the render, so homepage TTFB alone conceals the improvement. Health remains uncached and fast. These loopback timings exclude Cloudflare and client network latency.

The first post-deploy requests were explicit cache **MISS** responses: homepage TTFB/total **2,357.829 / 2,368.536 ms**, game report **2,139.850 / 2,162.482 ms**. Cold renders remain slower under the CPU cap. Warm cache hits avoid that render work; a page becomes eligible for background regeneration after 60 seconds, and stale content can persist while a refresh fails.

The following `cpu.stat` deltas bracket the same 60-request sequences. The web container was recreated between samples, so only within-sample deltas are compared.

| Container | Observation | Elapsed | `nr_periods` delta | `nr_throttled` delta | Throttled periods | CPU usage delta | Throttled-time delta |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Web | Before | 23.39 s | 234 | 206 | 88.03% | 11.209 s | 25.815 s |
| Web | Warm after | 1.86 s | 19 | 8 | 42.11% | 0.770 s | 0.147 s |
| Database | Before | 23.39 s | 120 | 22 | 18.33% | 2.298 s | 1.053 s |
| Database | Warm after | 1.86 s | 5 | 0 | 0.00% | 0.035 s | 0.000 s |

Web `nr_throttled` changed from 216,733 to 216,939 during the baseline and from 110 to 118 during the warm after sample. Database counters changed from 132,582 to 132,604, then from 135,324 to 135,324. The short, unequal observation windows and shared-host/background activity limit interpretation: these measurements show reduced work for the measured requests, not sustained production throttling rates. Throttled time is the cgroup counter, not wall-clock request delay.

GitHub Actions was experiencing a [reported service incident](https://www.githubstatus.com/incidents/8tzbpcnl75jp). Both [application run 39283217666](https://github.com/yaboijbigs/under-review/actions/runs/39283217666) and [corrected-test run 39284618414](https://github.com/yaboijbigs/under-review/actions/runs/39284618414) were queued without a runner at deployment time. At final verification the application run had started and the corrected-test run remained queued; **neither run had passed**. No CI image was claimed or substituted into `deploy/images.json`.

The fallback built the production standalone artifact off the VPS, then packaged it in Docker-save format using the pinned Node base and the runtime settings from `Dockerfile.web`. Base blob hashes and uncompressed layer digests were verified. The archive was transferred, loaded, and deployed as `under-review-web:perf-f87f63731c98c81b4859383c27d5c27ce290e0a2`; no dependency or Next.js build ran on the VPS. The previous image remains `ghcr.io/yaboijbigs/under-review-web@sha256:7736ce62132474acea24f12d24750dc9ab59df687a308ecd8dcfa7b16df6cc40`.

| Provenance item | Recorded value |
| --- | --- |
| Runtime base | `node:24.15.0-bookworm-slim`, `linux/amd64` |
| Base index digest | `sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d` |
| Base platform manifest digest | `sha256:152aceace5c03e2597988763165ee33e3fd3633636db0fc983cd2e126b02cfde` |
| Base configuration digest | `sha256:3880cf501a3b54bacc5e53dc327478ba723084863fa252cceb43f75aadcab12b` |
| Application layer uncompressed digest | `sha256:56ccac22266a718bece7d0b306e195d288d74d2337e2bea3c4b53ed6abb0b137` |
| Loaded manifest/image ID | `sha256:93271f25572cdb491783e905d7e0b3e141bf79d665c8f2cb9becc41024ff4473` |
| Image configuration digest | `sha256:525f6acaf11fd6007593df721f15303fda25aaa1e89e9fcb6e0803c307f7016e` |
| Archive SHA-256 | `4bdfa6ad5965c17f364bb2801017f65f9c3e12aa68ee1f0964f91fc9c957d828` |
| Archive size | 126,330,516 bytes |
| Next build ID | `64X-GOsSRRlC666_9apbH` |

Docker 29.1.3's containerd image store reported the manifest digest above as its image ID; it is distinct from the configuration digest. Every loaded configuration field and all six root filesystem layer digests matched the archive; `linux/amd64` was confirmed. The local archive filename is `under-review-web-perf-f87f63731c98c81b4859383c27d5c27ce290e0a2.tar.gz`.

Build, runtime, and browser verification used **Node 24.15.0**, Next.js 16.3.5, Playwright 1.63.0, and Chrome 155.0.8059.84. The full unit/database suite used Node 24.22.0 and disposable PostgreSQL 17.11. TypeScript checks, production build, frozen-reference verification, **796 tests in 42 files with PostgreSQL integration enabled**, runtime branding/indexing tests, and **36 desktop/mobile browser tests** passed. Production ISR smoke passed locally and on the deployed VPS, covering shared cache hits, historical revision selection, filters, disabled origin compression, fresh APIs, and admin authentication. An additional smoke test passed in the exact base-image root filesystem as UID/GID 1000 with application write permissions removed and a synthetic PostgreSQL fixture. No live fixture seeding was performed.

Browser verification used the same selections as `.github/workflows/verify.yml`, two workers, `PLAYWRIGHT_CHANNEL=chrome`, game `2025_12_MIN_GB`, season 2025, and historical revisions 1 and 2. The navigation/report selection passed 18 tests, and the feedback suite passed 18 tests. Local evidence was retained under `/workspace/codex-under-review/local-browser-evidence`; raw timing, plan, deployment, and artifact records were retained alongside it. Credentials and environment file contents are excluded from this report.

Live revalidation was observed after the 60-second interval: the origin returned `STALE` in 27.861 ms at 16:25:47 UTC, then `HIT` in 22.434 ms at 16:26:15 UTC. Public HTTPS returned 200 with origin `x-nextjs-cache: HIT`, Cloudflare Brotli `Content-Encoding: br`, and Cloudflare cache status `DYNAMIC`. Final web memory was 128.1 MiB of 512 MiB; database memory was 292.9 MiB. Both containers were healthy at 0.5 CPU with zero restarts. New web logs contained no `MaxListenersExceededWarning`, `EROFS`, `EACCES`, or `web.report.failed` entries during this short verification period. Server evidence is retained under `/docker/under-review/backups/20261019T155743Z-performance/verification`.

To undo the web deployment on the VPS, preserve the current environment and log before restoring the recorded backup. Run only these project-scoped commands; the Compose file itself was not changed by this deployment.

```sh
set -eu
cd /docker/under-review
ur_undo_stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
cp -p .env ".env.before-undo-$ur_undo_stamp"
cp -p /root/gordon-cpu-changes.log "/root/gordon-cpu-changes.log.bak-$ur_undo_stamp"
printf '%s Under Review: restore pre-performance WEB_IMAGE environment and recreate only web. Undo this rollback: restore /docker/under-review/.env.before-undo-%s and recreate only web with --no-deps --pull never.\n' "$ur_undo_stamp" "$ur_undo_stamp" >> /root/gordon-cpu-changes.log
cp -p /docker/under-review/.env.bak-20261019T162331842046Z .env
docker compose -p under-review up -d --no-deps --pull never web
docker inspect under-review-web-1 --format '{{.State.Health.Status}}'
docker inspect under-review-web-1 under-review-db-1 --format '{{.Name}} {{.HostConfig.NanoCpus}}'
curl --fail --silent --show-error http://127.0.0.1:4380/api/health
```

Wait for web health to become `healthy`; both CPU values must remain `500000000`. Re-run the same 20-request measurements after rollback. The unchanged Compose backup is `/docker/under-review/docker-compose.yml.bak-20261019T162331842046Z`; restoring it is unnecessary for this web-only rollback.

The indexes are additive and compatible with the previous image, so they can remain during an application rollback. If removing them is desired, use separate autocommit commands, never a surrounding transaction or a combined SQL `-c` string. Record the removal and its undo first:

```sh
set -eu
umask 077
ur_index_undo_stamp=$(date -u +%Y%m%dT%H%M%S%NZ)
ur_index_undo_dir="/docker/under-review/backups/$ur_index_undo_stamp-before-index-undo"
cp -p /root/gordon-cpu-changes.log "/root/gordon-cpu-changes.log.bak-$ur_index_undo_stamp"
printf '%s Under Review: capture pg_dump in %s before dropping only source_snapshots_provider_retrieved_at and games_season_kickoff_at concurrently. Undo: retain backup evidence; take a fresh pg_dump, then reapply scripts/sql/20261019-hot-query-indexes.sql in autocommit and verify both indexes valid/ready.\n' "$ur_index_undo_stamp" "$ur_index_undo_dir" >> /root/gordon-cpu-changes.log
mkdir -m 700 "$ur_index_undo_dir"
docker exec under-review-db-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' > "$ur_index_undo_dir/database.dump"
docker exec -i under-review-db-1 pg_restore --list < "$ur_index_undo_dir/database.dump" > "$ur_index_undo_dir/database.contents"
sha256sum "$ur_index_undo_dir/database.dump" > "$ur_index_undo_dir/database.sha256"
docker exec under-review-db-1 sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP INDEX CONCURRENTLY IF EXISTS public.source_snapshots_provider_retrieved_at;"'
docker exec under-review-db-1 sh -c 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP INDEX CONCURRENTLY IF EXISTS public.games_season_kickoff_at;"'
```

Neither rollback requires restoring the database dump or removing any volume, image, backup, or application record. Keep the dump as recovery evidence; restoring it would be a separate operation that could discard newer data.
