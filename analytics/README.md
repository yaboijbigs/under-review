# R analytics

Overtime momentum uses a separate TypeScript estimator with a frozen historical reference; see [its methods, coverage and evaluation](OVERTIME.md). It does not change the regulation R model or enable overtime counterfactuals.

The worker invokes `Rscript analytics/run.R request.json response.json`. Input uses `action: "analyze"` with the shared game, original nflverse plays, FTN rows, immutable snapshot references and config. `action: "build_pbp"` accepts `gameId` and a local `rawDirectory`. JSON is written only to the supplied response file. Errors return `error.code` and exit nonzero; unsupported individual metrics return null plus a reason.

## Local commands

```sh
docker build -f analytics/Dockerfile -t under-review-analytics:local .
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/freeze.R
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/tests/run.R
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/train.R 2015 2022 2023 2024 2025
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/evaluate_coaching.R 2025 2026
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/reference_baselines.R
docker run --rm -v "$PWD:/app" -w /app under-review-analytics:local Rscript analytics/calibrate.R reports analytics/models/category-reference.json
```

PowerShell uses `${PWD}` in the volume argument. Training requires internet for public nflverse downloads; analysis uses bundled local artifacts. Never pass untrusted arbitrary executable paths or command strings to the worker.

## Established state models

Pins: R 4.5.2, nflreadr 1.5.0, nflfastR 6.0.0, nfl4th 1.0.7, fastrmodels 2.1.0. The Docker build restores the complete `renv.lock` dependency closure and checks every installed version. `models/manifest.json` records upstream artifact hashes; `models/evaluation.json` records trained baseline hashes and immutable derived training inputs. Model binary licenses follow their upstream package attribution; data licenses are separate (see root DATA_SOURCES.md).

Officiating uses non-spread nflfastR WP. Input `spread_line=0` merely satisfies a wrapper that also computes a discarded spread-adjusted output. The named home team's perspective is constant, with timeout ownership transformed for possession. WP deltas are fractions (`wp_delta`); display multiplication by100 yields percentage points. Published training excludes final ties and OT. There is no terminal tie probability estimate, and all OT alternatives are excluded. EP coverage currently includes only nonscoring state comparisons to avoid ambiguous scoring-horizon arithmetic.

Automatic alternative states cover single accepted presnap false start/delay/encroachment/neutral-zone enforcement and unambiguously recorded incomplete passes with a single defensive automatic first down. All clauses are retained. Multiple, declined, offsetting, replay, scoring/turnover, last-two-minute and ambiguous cases are reason-coded; never treat whole-play WPA as penalty impact. No automated correctness judgments occur.

## Fourth-down adaptation and validation gate

The unmodified MIT upstream files under `vendor/nfl4th` are sourced into an isolated environment. The adapter injects frozen model objects and explicit snapshot context; it never calls the package's mutable schedule/model download path. Its method remains the upstream spread-adjusted blended WP family. Schedule spread and total are required; missing values disable the metric.

The versioned adaptation parameterizes kickoff continuation, resets timeouts at halftime and refreshes possession-owned EP timeout and elapsed-time features. Standard2026 touchbacks start at own35; own20 exceptions (including kicks from50) are explicit sensitivity scenarios. Neither branch alone is a validated expected kickoff distribution. Prior-only historical ordinary kickoff-start quantiles add empirical sensitivity when at least100 appropriate prior rows exist. Action changes and crossings of the1pp product tolerance are flagged. Fixed six-second play duration, no modeled turnover returns and the other upstream limitations remain visible. The football event itself supplies no eventual outcome to the decision calculation.

Supported domain is regulation, more than15 game seconds remaining, down4, distance at most30, field position outside own10, known ordinary chosen action and complete context. Unsupported action outputs remain null. Fakes, aborted/penalty-obscured decisions, overtime, special kickoff continuations and own-goal safety branches are excluded.

Parity tests compare the unchanged legacy configuration to installed upstream1.0.7 on identical frozen inputs. Branch tests cover possession and halftime. The observed-action evaluator records2025 and available2026 coverage, calibration/Brier/log-loss and kickoff-sensitivity changes. Promotion requires recorded passing parity/state/predecision tests, at least500 go and FG observations in2025, each Brier no worse than its prior-season constant baseline plus0.005, at least10 games and30 go/FG observations in2026 with finite action outputs, and at least100 prior2025 kickoff starts. Passing promotion enables only model-relative estimates in the supported domain when recommendations and the1pp tolerance classification remain unchanged across all kickoff scenarios. Sensitive estimates stay experimental. Missing, failed or stale evidence leaves coaching experimental. **These diagnostics do not identify unchosen action outcomes; current upstream training cutoff is unverified.**

## Trained baselines and calibration

Fumble recovery logistic regression uses sack/rush/forced-fumble status and preplay down/distance/field position. It excludes out-of-bounds, touchbacks, aborted snaps, multiple-fumble and nullified events. Recovery location and eventual yards are never predictors. Only recovery residuals are emitted; unsupported WP branches are not invented.

FG and XP are separate logistic models. FG uses spline distance, numeric era and observed roof category; XP uses distance/era/roof. Weather and kicker-history effects are not claimed. Blocked/nullified attempts are excluded, not blamed on the kicker. The calibration season fits only an intercept adjustment. Prediction rejects games at or before the training/calibration cutoff.

Called-penalty count models use family-specific opportunities, home/situation shares and prior-game-only team/opponent tendencies. A Poisson model switches to negative binomial if Pearson overdispersion exceeds1.5. Crew effects are not normalized away. Counts describe enforcement frequency, never whether fouls actually occurred. First-down counts are descriptive; an expected-first-down baseline is not yet claimed.

Training defaults are2015–2022, calibration2023, held-out evaluation2024–2025. The report records sources, dataset checksums, sample counts and calibration metrics. The category-reference command accepts `{gameId, revisionNumber, analysis}` (or the root report shape with `game.id`, `revision.number` and `revision.analysis`). It chooses the latest revision per canonical game and compares identical metric/model/full-coverage strata, with one maximum absolute value per game and at least200 distinct games. Missing identifiers and conflicting same-game revisions are rejected. No overall percentile is emitted.

`run.R` also exposes JSON actions `train`/`calibrate` with a manifest containing `trainStart`, `trainEnd`, `calibrationSeason`, `testStart`, `testEnd`; `evaluate` with `{kind:"coaching",seasons:[2025,2026]}`; and `percentiles` with `{reportsDirectory:"..."}` or `{kind:"baseline_reference"}`. These commands explicitly rebuild artifacts; ordinary analysis remains offline.

Bundled category references use frozen held-out2024–2025 fumble/FG/XP inputs, with no refitting. Inference requires a later season, identical model hash, complete coverage, the same combined game opportunity-count stratum, at least200 distinct games, and at least5 observations in either empirical tail. The comparison ranks a team's absolute residual against each historical game's maximum absolute team residual; the signed metric retains direction. Percentiles use whole-number precision. Sparse strata and all other categories display unavailable. This is a descriptive historical comparison; no overall or multiple-category significance claim is made. See `VALIDATION.md` for measured coverage.
