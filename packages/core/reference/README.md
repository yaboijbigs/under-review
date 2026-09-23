# Expected versus actual reference

`expectations-reference.json` contains 6,947 regular-season games from 1999–2025, projected from the existing immutable paired team-game reference, plus referee attribution records. It contains no visitor, operator, credential, or publication data. It is stored outside a directory named `data` so the container build context retains it.

Data is **CC BY 4.0**, attributed to **nflverse / nflfastR** and **Lee Sharpe** for schedules. The application MIT license does not replace these data terms. Original URLs, checksums, retrieval times, available Last-Modified values, and source notices are retained in the reference. Transformations include regular-season filtering, paired-team projection, referee joins, alias normalization, and conflict exclusion. See the [data license](https://raw.githubusercontent.com/nflverse/nflverse-data/main/LICENSE.md), [team statistics loader](https://nflreadr.nflverse.com/reference/load_team_stats.html), [penalty calculation](https://raw.githubusercontent.com/nflverse/nflfastR/master/R/calculate_stats.R), [schedule dictionary](https://raw.githubusercontent.com/nflverse/nflreadr/main/data-raw/dictionary_schedules.csv), and [officials loader](https://nflreadr.nflverse.com/reference/load_officials.html).

The officials source is [officials.csv](https://github.com/nflverse/nflverse-data/releases/download/officials/officials.csv), 1,293,787 original bytes, SHA-256 `9a54dffc1ed36a4a36437e7b526b2ce142eff936134a3ccb620c56d8e0f4f38c`. Its retained gzip archive preserves those exact bytes. The downloaded snapshot covers 2015–2025 and 2026 Week 1 assignments; it does not contain 2026 Week 2 crew assignments. Later schedule-only attribution is explicitly labeled.

`officials.game_key` joins `schedules.gsis`; date-shaped `game_id` is not used because it reindexes for some postponed games. Official IDs change namespace in 2023. An explicit name-alias map handles recorded spellings without fuzzy matching. The frozen join identifies 15 conflicting referee assignments and excludes those games from referee-specific samples. A schedule name is the head official, not a fixed crew or attribution of each flag. A missing assignment, conflict, or fewer than ten qualifying referee games leaves the referee effect unavailable. The separately calibrated team/opponent model remains usable. Before the officials feed starts, attribution is schedule-only. The unjoined 2019 Super Bowl does not affect this regular-season model.

## Reproduction

Run from the repository root:

```sh
node scripts/build-expectations-reference.mjs --verify
node scripts/build-expectations-reference.mjs
```

The first command checks byte-identical offline reproduction without changing files. The second rebuilds using only the existing frozen team-profile inputs, compressed schedules, and officials archive. `--refresh-officials` explicitly downloads a new public officials snapshot; do not use it for release verification. A refresh changes provenance/checksums and must be reviewed as a new artifact. No R fitting or VPS work is involved.

## Estimation and chronological calibration

Only the target's preceding **five completed regular seasons** enter fitting. All five seasons must be represented. At least 500 complete games are required for a fitted family. The current and future seasons are excluded; postseason targets are unsupported. Historical source revisions can contain later provider corrections, so this is chronological outcome exclusion rather than a claim that every source byte was published before the historical kickoff.

For each team, calculate prior-game accepted penalty count/yards and the penalties drawn by its opponent. Both means are shrunk toward the league team-game average with a 20-game prior. The expected value is the league mean plus half each of the two shrunken deviations. League denominators are **team-games**. Referee denominators are **unique games**, with both teams' penalties summed once per game. The referee effect is the mean residual game total after the team/opponent expectation, shrunk with a 40-game zero-effect prior and divided equally across the two teams. Raw referee home/away means and team win/loss/tie history are context; team wins never enter an expectation or anomaly statistic.

The penalty-family statistic is the **maximum absolute standardized residual** across total penalty count, total penalty yards, home-minus-away count imbalance, and home-minus-away yards imbalance. Scales are sample standard deviations of training residuals. Count and yards are not added as separate votes. Both teams having many penalties can make the total unusual without implying a directional imbalance.

The outcome model is ordinary least squares with an intercept, final net offensive yard differential divided by 100, and final home turnover margin. It estimates the expected **home scoring margin conditional on the final box score**. This is retrospective, not a pregame prediction or a win probability. Its anomaly statistic is the absolute scoring-margin residual. Singular fits and missing inputs stay unavailable.

Each of the preceding three calibration seasons is scored using that season's own earlier five seasons. Referee-adjusted and team/opponent-only penalty calibrations are separate. Empirical tails are `(atLeastAsUnusual + 1) / (calibrationGames + 1)` and require at least 500 calibration games. Equality counts as at least as unusual. The model exposes raw family statistics, count denominators, residuals, scales, and exact reference file checksum. It does not fit an overall suspicion score.

## Executed diagnostics

Offline chronological outcome residual RMSE was 8.28 points for 2023, 8.84 for 2024, and 8.86 for 2025, across 272 games per season. A zero-margin comparator gave 14.64, 14.55, and 14.30 points respectively. These checks establish a descriptive improvement for this box-score model; they do not validate integrity or wrongdoing detection.

For the independently gamebook-checked 2026 GB–NYJ example, expected accepted penalty yards were 46.16 for GB and 51.05 for NYJ, versus 133 and 156 observed. The family maximum was 5.1216, driven by the game total; the count and yard imbalance statistics were only −0.4633 and +0.5651. No referee-adjusted calibration game was as extreme among 779 games, yielding the finite add-one tail 1/780. Expected NYJ margin was +10.949 given its net yardage/turnover advantage, versus −3 observed; the outcome tail was 85/817. This illustrates why total unusualness and one-sided advantage must remain distinct.

Not modeled: call correctness, uncalled fouls, officiating grades, a stable full crew, roster continuity, game-state/pace exposure, or overtime opportunity adjustments. Referee/team matchups are small descriptive samples, not evidence of personal intent.
