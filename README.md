# Under Review

**What actually swung the game?** An NFL game-audit microsite with real nflverse ingestion, versioned evidence, statistical models, and a durable X publishing outbox. An unusual game is not evidence of intentional misconduct. The application never estimates a probability that a game was rigged. Public source: [yaboijbigs/under-review](https://github.com/yaboijbigs/under-review).

Public website: **[underreview.jbigs.com](https://underreview.jbigs.com)**. All **32 games from 2026 regular-season Weeks 1–2** have completed reports, including Giants–Rams, which the worker analyzed automatically after final data arrived. Public browser/admin checks passed. See [RELEASE.md](RELEASE.md) for deployed versions and verification.

Next.js serves reports and authenticated administration. A separate TypeScript worker owns scheduling and ingestion; PostgreSQL stores revisions, reviews, jobs, and publication state. Pinned R models run through a bounded JSON subprocess contract. Sources, missing coverage, assumptions, and actual freshness accompany reports.

**Experimental candidate, not deployed:** this branch implements audit v6 / rating v4 for evaluation. Production retains audit v5 / rating v3. The candidate is blocked from promotion because its supported subset misses two of the three Green Bay–Minnesota drive extensions, while a large expected-points effect can produce an extreme alert in a low-leverage game state. Passing software checks does not resolve that mismatch with overall game fairness.

The candidate evaluates unusual net benefit from **supported regulation penalty enforcement**, across the whole game or one drive. It does not rate the final result, infer missed fouls or decide whether a recorded call was correct. Box-score expectations, the spread, momentum and notable plays remain context. The following model description covers this experimental candidate; older revisions retain their original algorithms.

Called-penalty rates condition on eligible opportunities, penalty family, play type, down, distance, field position, clock, score and home/away side, with pooled team and opponent tendencies. The 1,000-opportunity context prior was selected from 50/200/1,000 using 2021–2023 chronological predictions. Presnap rates do not use whistle-induced unknown play type as a predictor. Models use the preceding five completed regular seasons.

Supported effects compare learned expected points in the enforced state with a conservatively reconstructed alternative. Opposing benefits offset. The observed net benefit and its excess over expectation must favor the same side; the smaller effect is scaled by a working variance estimate. That statistic is not a validated normal z-score. We compare the maximum game/drive statistic with the same search in at least 500 supported games from the prior three seasons, each predicted using only its own earlier seasons. Rarity uses `(at least as unusual + 1) / (comparison games + 1)`. There are no fixed two/three-penalty rating floors.

This is a limited enforcement model, not a validated measure of overall fairness. In held-out 2024–2025 games, about one-third of accepted regulation penalties received an effect estimate; 96 of 544 games (about 18%) were Unrated. Unsupported alternatives, late-half states, overtime, and excluded penalty records do not become invented zero effects. A new alternative-state WP contrast was withheld after poor held-out calibration; the existing momentum chart remains separate. Full seven-role crew histories are retained as context, but predictive crew adjustments are disabled because their gains and directional repeatability were unreliable. See the [evaluation design](benchmarks/officiating/IMPLEMENTATION.md) and [corpus provenance](benchmarks/officiating/README.md).

Momentum charts connect available win-probability estimates without inventing intermediate values. A separate experimental overtime model compares states with matching possession rules and at least 20 distinct earlier-season games; unsupported phases retain their reasons. It reports win, loss and tie probabilities separately. An explicit game-end record appears as an observed endpoint, not a forecast. Every recorded entry remains inspectable. See [overtime design and evaluation](analytics/OVERTIME.md).

The contextual win-profile comparison checks seven combinations of offense below 200 yards, at least 100 penalty yards, and negative turnover margin. Its frozen reference contains 7,256 games from 1999–2025, with target comparisons restricted to earlier seasons. Sparse samples retain their exact counts. These profiles do not raise the candidate v4 rating. See [data provenance and reproduction](analytics/GAME_PROFILES.md) and the [earlier development evaluation](benchmarks/game-audit/README.md).

Visitors can vote from homepage game cards or a report. Choosing a thumb opens the Fair → RIGGED? slider and an optional explanation. New submissions are visibly labeled public and appear on the game page with their report version and rating context. Earlier private feedback remains private unless its author explicitly resubmits it. Responses never alter the calculated rating; a signed browser cookie allows updates without an account.

Reports also compare the recorded closing spread with the final margin using 7,276 prior-season games. This is context only under candidate v4: an unusually large miss does not raise the rating. Earlier revisions preserve their earlier spread rules. See [spread data methodology and source attribution](analytics/SPREAD_METHOD.md).

Automatic X posts use the report’s rating and supporting evidence. Activation records a future-kickoff cutoff, one initial post per game/account is enforced, and corrections remain manual. An administrator can explicitly authorize an individual historical game's first post without making the rest of the archive eligible. The admin page includes setup readiness and previews. See [publishing operations](OPERATIONS.md); OAuth credentials stay in the private server environment.

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

## Branding and runtime configuration

Set `BRAND_NAME`, `BRAND_TAGLINE`, and `SITE_URL` in the deployment environment. Optional `BRAND_ACCENT`, `BRAND_BACKGROUND`, and `BRAND_INK` override the existing accent, page background, and text colors; each must be a six-digit hex color, quoted in `.env` (for example, `BRAND_ACCENT="#e2ff54"`). Optional `SOCIAL_HANDLE` adds the public X profile link in the footer and accepts 1–15 letters, digits, or underscores without `@`. Invalid colors or handles fail configuration validation. Defaults retain the Under Review theme.

These settings and `PRIVATE_STAGING` are read when the web process starts, so an existing image can be configured without rebuilding it. Restart the web process after changes. Staging remains excluded from search indexing; set `PRIVATE_STAGING=false` explicitly for public indexing. After a web production build, `node apps/web/tests/runtime-config.mjs` verifies both runtime modes against that same build using isolated loopback servers.

## Commands and behavior

| Command after `npm run ur --` | Purpose |
| --- | --- |
| `migrate` | Apply checksummed migrations using the configured database. |
| `doctor` | Report database, source, worker, job, and publishing status. |
| `sync-season --season 2026` | Discover regular/postseason games from provider schedules. |
| `coverage --season 2026 --weeks 1,2` | Read stored schedule, latest report/audit status, and outstanding jobs for one or two regular-season weeks. |
| `catch-up --season 2026 --weeks 1,2` | Refresh the schedule and queue missing reports or missing game audits within that explicit scope. |
| `export-analysis --game GAME_ID --output bundle.json` | Export a verified clean-source automated report and its public source snapshots from the local build environment. |
| `import-analysis --input bundle.json` | Validate a matching bundle and save it without rerunning R or enabling publication; reject conflicting existing reports. |
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

The coverage/catch-up and analysis-transfer commands support bounded recovery. Bundles contain public source bytes and automated analysis, not an operational database, credentials, sessions, reviews, or publication state. Source/code/model checksums and final-data validation must match the destination. [OPERATIONS.md](OPERATIONS.md) describes the transfer procedure.

The one-time Week 1–2 import is complete. Normal deployments retain the existing report database, apply additive migrations, and start the automatic worker without reimporting old bundles. A separate coverage check verifies Week 1–2 reports. Website readiness does not depend on a social draft or a human officiating review.

The five-level scale remains **Fair → Debatable → Hmm → Sus → RIGGED?**, with **Unrated** outside it when evidence is insufficient. In candidate v4, calibrated rarity at or below 20%, 10%, 3% and 0.5% qualifies for levels 2–5. The benefiting team need not win. Fair applies only to the supported enforcement subset; RIGGED? is an extreme statistical alert, not a finding of misconduct. Routine notable-play counts cannot inflate the rating. Once cleaned play-by-play has been analyzed, raw jobs cannot replace it. Startup repairs an equivalent older source regression transparently, or queues fresh clean analysis when the evidence differs.

The worker runs one job at a time, renews durable leases, retries failed jobs with backoff, polls around game windows, and schedules clean statistical reconciliation. Source changes create new analysis revisions. Old revisions remain addressable by `?revision=N`; corrected findings and review scope remain visible. A new raw-source revision is preliminary even when its modeled values match an earlier clean report, because unmodeled fields may differ. Matching modeled values alone do not produce a corrected-finding label.

## Analytics, tests, and limits

The [controversial-game benchmark](benchmarks/controversy/README.md) runs five documented disputed games and two comparison games through the actual pipeline without changing models or adding reviews. Its [observed results](benchmarks/controversy/RESULTS.md) document gaps between automatic impact reporting and the incidents behind public controversy, plus a historical finality regression and fix.

Verified source contracts and fixture attribution are in [DATA_SOURCES.md](DATA_SOURCES.md); model commands, domains, and assumptions are in [analytics/README.md](analytics/README.md). The checked-in real fixtures cover `2023_01_DET_KC` and `2026_01_NE_SEA`, including separately licensed FTN rows. Synthetic tests are explicitly labeled and cannot enter production publishing.

Recorded checks on 2026-09-21 passed all 56 TypeScript unit/integration tests, including real PostgreSQL tests with isolated schemas; 50 R assertions and additional model-contract checks; TypeScript checks; the production web build; and 12 desktop/mobile browser tests. Runtime configuration was also verified in both private and public modes against the same built web artifact. The historical game passed both clean and raw worker pipelines with 57 matching metric values/statuses; the current-season pipeline produced 70 metric records and reused its revision on identical input. Status and coverage vary by metric: these are not counts of officiating errors. The executed release checks are recorded in [RELEASE.md](RELEASE.md), with recovery procedures in [OPERATIONS.md](OPERATIONS.md).

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

Coverage is explicit: automatic officiating alternatives use a small supported allowlist; call correctness and missed fouls remain unknown to the rating. Coaching adaptations remain experimental where modern-rule validation is incomplete. FTN tags are observations, not causal error costs. Recovery and kicking WP effects, clock-management models, two-point/onside decision models, comprehensive missed-call detection, and betting-integrity detection are not implied by a report.

## Publishing and deployment

Defaults are `PRIVATE_STAGING=true`, `LIVE_POSTING_ALLOWED=false`, draft-only mode, and an enabled kill switch. X connection and automatic-mode activation are authenticated operator actions. Tests never submit real posts. Ambiguous submissions become `unknown_outcome`: an administrator can link an existing post only after API verification of its author, full text, and report URL, or permanently cancel further submission. An absent post is not permission to resend. Database uniqueness does not guarantee exactly-once external delivery.

The [public application source](https://github.com/yaboijbigs/under-review) uses the [MIT license](LICENSE). Public web and worker images are published to GHCR; [deploy/images.json](deploy/images.json) records the verified immutable digests and their source revisions. Application-code licensing is separate from the CC BY 4.0 nflverse data, CC BY-SA 4.0 FTN data, and third-party model/package notices; retain [DATA_SOURCES.md](DATA_SOURCES.md) and fixture attribution. Credentials, operational databases, and local caches are excluded from the public release.

For the existing shared Hostinger VPS, use the isolated additional-project procedure in [OPERATIONS.md](OPERATIONS.md). Build and test immutable public images off the VPS. Public images do not change the private network, database isolation, or disabled live-posting defaults. [RELEASE.md](RELEASE.md) distinguishes the executed Hostinger deployment checks from local verification and lists remaining operator actions.
