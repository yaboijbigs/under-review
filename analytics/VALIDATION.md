# Analytics validation record

Executed locally on **2026-09-21**, using R4.5.2, nflfastR6.0.0, nfl4th1.0.7, fastrmodels2.1.0 and the checked-in `renv.lock`. Raw PBP decoding additionally requires gsisdecoder0.0.1 and Rcpp1.1.2, included in the final lock. Model and source checksums live in `models/manifest.json`, `models/evaluation.json` and `models/coaching-evaluation.json`. The Docker restore verified every installed R package version. Public releases may later change; these results describe the recorded snapshots.

## Chronological baseline results

Training:2015–2022. Calibration:2023. Held-out evaluation:2024–2025. No refit used the held-out outcomes.

| Baseline | Held-out observations | Brier | Training-constant Brier | Log loss |
| --- | ---: | ---: | ---: | ---: |
| Fumble recovery | 765 | 0.23467 | 0.25051 | 0.66200 |
| Field goal | 2,256 | 0.10363 | 0.11693 | 0.34044 |
| Extra point | 2,579 | 0.03254 | 0.03334 | 0.14495 |

Called-penalty model:4,560 team/family/game observations; Poisson Pearson dispersion1.038. Before its2023 multiplicative calibration adjustment0.99186, held-out count RMSE1.001, mean observed0.934 and predicted0.840. The full ten-bin probability calibration tables and immutable derived input filenames are recorded in `models/evaluation.json`.

Fumbles exclude multiple, out-of-bounds, touchback, aborted and nullified events. Kicking excludes blocked/nullified outcomes and uses distance, era and observed roof; it does not claim weather or kicker-history adjustment. Penalty models describe called/enforced fouls, not foul occurrence or correctness. Predicting games at or before the calibration cutoff is prohibited.

## Fourth-down observed-action diagnostics

| Season | Fourth-down rows | Modeled rows | Games with modeled rows | Chosen go / FG observations | Go / FG Brier |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2025 | 4,290 | 3,658 | 285 | 888 / 977 | 0.22685 / 0.09714 |
| Available2026 snapshot | 452 | 374 | 31 | 64 / 106 | 0.23574 / 0.11340 |

The2025 prior-season constant comparators scored0.24706 for go and0.10437 for FG. Every modeled2026 row had at least two finite action values. Comparing own35 and own20 kickoff continuations changed the preferred action on339 modeled2025 rows and41 modeled2026 rows. Additional inference scenarios use quantiles of at least100 ordinary kickoff starts from strictly prior games in the relevant rule era.

All ten promotion checks passed: upstream parity, rule-transition tests, predecision-only invariance, current adapter and state checksums, prior sample size, both prior Brier comparisons, current-season coverage and empirical kickoff support. Promotion applies only to supported regulation decisions insensitive to all available kickoff scenarios. Other estimates remain experimental or unavailable. Passing this release gate establishes a bounded **model-relative** estimate; observed chosen actions do not identify unchosen counterfactual outcomes.

**Upstream training cutoff remains unverified.** These retrospective nfl4th diagnostics cannot be called leakage-free. Published nflfastR WP methodology excludes final tied games and overtime; supported in-progress regulation ties are not a terminal tie-probability model. OT, terminal ties, ambiguous/fake/aborted decisions, own-goal safety branches and unsupported rule states are excluded. Six-second action duration and simplified kickoff continuations remain assumptions; own35 alone is not a validated expected kickoff distribution.

## Historical category references

`reference_baselines.R` builds actual references offline from the frozen held-out2024–2025 inputs and model objects. Every game contributes at most one maximum absolute team residual per metric. Opportunity strata use total eligible events across both teams. Four strata pass the200-distinct-game gate:

| Metric | Game opportunity stratum | Distinct games |
| --- | --- | ---: |
| Fumble recovery residual | 1 | 202 |
| Field-goal point residual | 3–4 | 265 |
| Extra-point residual | 3–4 | 217 |
| Extra-point residual | 5–8 | 252 |

Inference compares a team's absolute residual against the historical per-game maxima; the original signed metric preserves benefit direction. It requires the same model hash, full coverage and stratum, and a target season after the reference period. Fewer than five observations in either empirical tail suppresses the percentile; otherwise only a whole percentile is displayed. Other strata and categories are visibly unavailable. These descriptive comparisons are not p-values, intent probabilities, or adjusted evidence across correlated categories. **Overall percentile remains unavailable.**

The general report calibration command selects the latest numbered revision per canonical game, rejects conflicting equal revisions, and never counts the two team views as separate games. It can extend reference coverage when a comparable report corpus exists.

## Executed checks and remaining coverage limits

- R suite:48 assertions passed, including frozen-input upstream parity, possession and timeout ownership, halftime kickoff transitions, spread invariance for officiating WP, predecision outcome invariance, conservative penalty constructors, leakage guards and two real game analyses.
- JSON contract regression passed for mixed numeric/string field-side values. Missing charting and zero labels remain distinct. Real2026 FTN denominators:57 nonsack passing opportunities and5 sacks.
- Distinct-game/revision calibration, model matching, chronological reference use, incomplete coverage, minimum sample and tail-suppression tests passed.
- Real fixtures:2023_01_DET_KC and2026_01_NE_SEA, with source/checksum/license manifest under `tests/fixtures/real`. Root TypeScript contract accepted the original R reports; rarity is an additional optional contract field.

Only explicit presnap and incomplete-pass automatic-first-down alternatives are automated for officiating. Scoring/turnover erasures, ambiguous clocks, multiple penalties and other unsupported alternatives require review. No automated correctness judgment, recovery/kicking error-attributable WP, clock-management model, or aggregate alternate final score is claimed. Partial statistical coverage is reported alongside every result.
