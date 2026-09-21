# Under Review

**What actually swung the game?** An NFL game-audit microsite with real nflverse ingestion, versioned evidence, R analytics, human officiating review, and a durable X publishing outbox. An unusual game is not evidence of intentional misconduct. The application never estimates a probability that a game was rigged. Public source: [yaboijbigs/under-review](https://github.com/yaboijbigs/under-review).

Next.js serves reports and authenticated administration. A separate TypeScript worker owns scheduling and ingestion; PostgreSQL stores revisions, reviews, jobs, and publication state. Pinned R models run through a bounded JSON subprocess contract. Sources, missing coverage, assumptions, and actual freshness accompany reports.

## Start locally

Requirements: Node.js 24, npm, and Docker with Compose. Run from the repository root. No X credentials, paid API access, or LLM account is required.

```sh
npm ci
npm run local:init
docker build -f analytics/Dockerfile -t under-review-analytics:local .
docker compose up --build -d
docker compose run --rm worker npm run ur -- doctor
```

Open [http://localhost:4380](http://localhost:4380). The local web and PostgreSQL bindings are loopback-only (`4380` and `5439`). `local:init` creates random local secrets in ignored `.env` and preserves existing configuration. PostgreSQL and source snapshots have separate persistent volumes; pinned model artifacts ship in the worker image. The one-shot migration service runs before the web and worker start.

Create an administrator by providing `UR_ADMIN_PASSWORD` through your shell environment, then forwarding that variable without putting its value in a command argument:

```sh
docker compose run --rm -e UR_ADMIN_PASSWORD worker npm run ur -- admin:create --username owner
```

Use at least 14 characters and remove the environment variable afterward. On PowerShell 7, `$env:UR_ADMIN_PASSWORD = Read-Host -MaskInput 'Admin password'` reads it without displaying it. `--role reviewer` creates an independent reviewer. The interactive CLI prompt is also available when the variable is absent. Never commit `.env`, passwords, OAuth tokens, or private deployment configuration.

Run the real-game vertical slice explicitly:

```sh
docker compose run --rm worker npm run ur -- sync-season --season 2023
docker compose run --rm worker npm run ur -- analyze-game --game 2023_01_DET_KC --backfill --clean
docker compose run --rm worker npm run ur -- draft --game 2023_01_DET_KC
docker compose run --rm worker npm run ur -- sync-season --season 2026
docker compose run --rm worker npm run ur -- analyze-game --game 2026_01_NE_SEA --backfill --clean
docker compose run --rm worker npm run ur -- draft --game 2026_01_NE_SEA
```

`--backfill` prevents automatic posting and follow-up scheduling for that invocation; `draft` creates a dry-run preview. Omit `--clean` to attempt the per-game raw-PBP builder first, with clean data as fallback. A game fails publication validation if its explicit terminal record, scores, or completeness checks do not reconcile. Unsupported model results stay unavailable or experimental.

## Commands and behavior

| Command after `npm run ur --` | Purpose |
| --- | --- |
| `migrate` | Apply checksummed migrations using the configured database. |
| `doctor` | Report database, source, worker, job, and publishing status. |
| `sync-season --season 2026` | Discover regular/postseason games from provider schedules. |
| `analyze-game --game 2026_01_NE_SEA` | Validate and analyze one game; raw first for an initial report. |
| `analyze-game --game 2026_01_NE_SEA --clean` | Request clean-source reconciliation for a game. |
| `analyze-game --game 2023_01_DET_KC --backfill --clean` | Historical analysis without automatic posting. |
| `backfill --season 2023` | Sequential historical clean-data processing; no automatic social posts. |
| `reconcile --season 2026` | Sequential clean-data reconciliation; no automatic social posts. |
| `draft --game 2026_01_NE_SEA` | Prepare an evidence-constrained, platform-length-checked dry-run post. |
| `admin:create --username owner` | Create an administrator; optional `--role reviewer`. |
| `train --input manifest.json --output result.json` | Run chronological baseline fitting, calibration, and held-out evaluation off the VPS. |
| `calibrate --input manifest.json --output result.json` | Re-run the complete baseline train/calibration/evaluation pipeline for the specified windows. |
| `evaluate --input manifest.json --output result.json` | Run coaching diagnostics or read the saved baseline holdout evaluation. |
| `percentiles --input manifest.json --output result.json` | Build compatible category reference distributions from real report exports. |

Use these inside the worker container for its pinned R runtime. Host commands use `.env` and require a compatible `Rscript` installation; `RSCRIPT_BIN` and `ANALYTICS_SCRIPT` can configure that runtime. Missing R produces a structured failure, never substitute statistics. Historical training and broad backfills belong on the development/build machine, not the shared VPS.

The worker runs one job at a time, renews durable leases, retries failed jobs with backoff, polls around game windows, and schedules clean statistical reconciliation. Source changes create new analysis revisions. Old revisions remain addressable by `?revision=N`; corrected findings and review scope remain visible. A new raw-source revision is preliminary even when its modeled values match an earlier clean report, because unmodeled fields may differ. Matching modeled values alone do not produce a corrected-finding label.

## Analytics, tests, and limits

Verified source contracts and fixture attribution are in [DATA_SOURCES.md](DATA_SOURCES.md); model commands, domains, and assumptions are in [analytics/README.md](analytics/README.md). The checked-in real fixtures cover `2023_01_DET_KC` and `2026_01_NE_SEA`, including separately licensed FTN rows. Synthetic tests are explicitly labeled and cannot enter production publishing.

Recorded local checks on 2026-09-21 passed source/bridge tests, seven isolated database tests, eleven mocked-transport publication integration tests, TypeScript checks, and 48 R assertions. The historical game passed both clean and raw worker pipelines with 57 matching metric values/statuses; the current-season clean pipeline produced 70 metric records and reused its revision on identical input. Status and coverage vary by metric: these are not counts of officiating errors. Container deployment and external service checks are tracked separately in [OPERATIONS.md](OPERATIONS.md).

```sh
npm test
npm run typecheck
```

For real database tests against the configured local PostgreSQL instance, set `RUN_DB_TESTS=1` and run `npx vitest run tests/database.integration.test.ts tests/publishing.integration.test.ts`. Each suite creates and removes its own temporary schema; it does not clear application data. Tests cover revision/draft idempotency, historical score preservation, concurrent job claims, lease recovery, manual review evidence, disabled live posting, and publication recovery. All X transport is mocked.

Run R tests and model work off the VPS:

```sh
docker build -f analytics/Dockerfile -t under-review-analytics:local .
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/tests/run.R
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/train.R 2015 2022 2023 2024 2025
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/evaluate_coaching.R 2025 2026
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/calibrate.R reports analytics/models/category-reference.json
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/reference_baselines.R
```

PowerShell volume syntax is `-v "${PWD}:/app"`. Training records chronological windows, model artifacts, and held-out diagnostics. Category comparison data requires compatible coverage and adequate distinct-game support; the overall percentile remains unavailable until an aggregate procedure is independently validated.

CLI training/calibration manifests contain `{"trainStart":2015,"trainEnd":2022,"calibrationSeason":2023,"testStart":2024,"testEnd":2025}`. Coaching evaluation uses `{"kind":"coaching","seasons":[2025,2026]}`; `{"kind":"baselines"}` reads the recorded holdout diagnostics. Category references use `{"reportsDirectory":"/app/reports"}` for compatible report exports or `{"kind":"baseline_reference"}` for frozen 2024–2025 baseline holdout inputs. Paths must be accessible inside the chosen runtime. These commands are blocked when `VPS_STAGING=true`.

Supported historical comparisons currently cover four adequately populated fumble/field-goal/extra-point strata; model version, coverage, opportunity count, and tail support must match. Coaching, penalty, execution, and overall reference percentiles remain unavailable. The comparator uses one maximum absolute team residual per historical game; it is not a probability of misconduct. Exact diagnostics and counts are in [analytics/VALIDATION.md](analytics/VALIDATION.md).

Coverage is deliberately explicit: automatic officiating alternatives use a small supported allowlist; call correctness requires human evidence and approval. Coaching adaptations remain experimental where modern-rule validation is incomplete. FTN tags are observations, not causal error costs. Recovery and kicking WP effects, clock-management models, two-point/onside decision models, comprehensive missed-call detection, and betting-integrity detection are not implied by a report.

## Publishing and deployment

Defaults are `PRIVATE_STAGING=true`, `LIVE_POSTING_ALLOWED=false`, draft-only mode, and an enabled kill switch. X connection and automatic-mode activation are authenticated operator actions. Tests never submit real posts. Ambiguous submissions become `unknown_outcome`: an administrator can link an existing post only after API verification of its author, full text, and report URL, or permanently cancel further submission. An absent post is not permission to resend. Database uniqueness does not guarantee exactly-once external delivery.

The [public application source](https://github.com/yaboijbigs/under-review) uses the [MIT license](LICENSE), with public container images as the release target. Application-code licensing is separate from the CC BY 4.0 nflverse data, CC BY-SA 4.0 FTN data, and third-party model/package notices; retain [DATA_SOURCES.md](DATA_SOURCES.md) and fixture attribution. Credentials, operational databases, and local caches are excluded from the public release.

For the existing shared Hostinger VPS, use the isolated additional-project procedure in [OPERATIONS.md](OPERATIONS.md). Build and test immutable public images off the VPS. Public images do not change the private network, database isolation, or disabled live-posting defaults. Deployment and external-route verification must be recorded separately from local code/test success; this README does not claim an unverified deployment is live.
