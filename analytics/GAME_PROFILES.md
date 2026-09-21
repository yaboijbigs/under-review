# Historical team-game profiles

`models/game-profiles.json` is a descriptive reference of **14,512 team-game rows from 7,256 games, seasons 1999–2025**, including regular season and postseason. It is not a trained overall score, an estimate of manipulation, or a claim about football before 1999. Historical comparisons must use **seasons strictly earlier than the target season**; the target, its opponent, same-season games, and future seasons must not enter that target's reference denominator.

## Reproduce the frozen artifact

From the repository root with Node 24 and the root dependencies installed:

```powershell
node analytics/build-game-profiles.mjs
```

This uses the 28 checked-in compressed source snapshots in `analytics/models/game-profile-sources/`, verifies every original CSV SHA-256, and reproduces the artifact offline. The original source bytes total 7,955,549 bytes; compressed snapshots total 2,310,895 bytes. The artifact records every URL, source checksum, retrieval time, HTTP metadata, transformations, exclusions, and per-season coverage. `rowsChecksum` hashes `JSON.stringify(rows)`; it does not hash its containing file.

To intentionally fetch updated public provider releases and replace the reference:

```powershell
node analytics/build-game-profiles.mjs --refresh
```

Optional arguments: `--start 1999 --end 2025 --output <json-path> --source-dir <archive-directory>`. Without `--refresh`, an existing output uses its recorded snapshots; absent or corrupt archives fail instead of silently fetching different bytes. With a new output, missing source records are downloaded. Refresh can change provider corrections and therefore historical counts; review and version the resulting artifacts together. This offline builder does not access application databases or deploy anything.

## Sources and field definitions

- [nflreadr team-stat loader](https://nflreadr.nflverse.com/reference/load_team_stats.html) and [loader source](https://raw.githubusercontent.com/nflverse/nflreadr/main/R/load_stats.R) establish the weekly aggregate files: `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_{season}.csv`.
- [Schedule release](https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv) supplies game identity, final scores, historical team codes, game type and dates.
- [nflfastR calculation source](https://raw.githubusercontent.com/nflverse/nflfastR/master/R/calculate_stats.R) documents the aggregate construction from play statistics.

| Output | Construction |
| --- | --- |
| `gameId`, `season`, `team`, `opponent` | Join `game_id`; display schedule team codes. |
| `pointsFor`, `pointsAgainst` | Schedule home/away scores, oriented to the named team. |
| `totalYards` | `rushing_yards + passing_yards + sack_yards_lost`. The sack field is already signed; do not subtract it again. Return yards are excluded. |
| `opponentYards` | Opponent's corresponding net offense. |
| `penalties`, `penaltyYards` | Provider `penalties`, `penalty_yards`: accepted penalty stat aggregates, not all flags or only the first penalty in a PBP row. |
| `giveaways`, `takeaways` | Own and opponent `passing_interceptions + fumbles_lost_total`, including lost fumbles on all units. Turnovers on downs are excluded. |
| `turnoverMargin` | Takeaways minus giveaways. |
| `nonOffensiveTouchdowns` | `def_tds + special_teams_tds` only when `fumble_recovery_tds` is observed zero. Positive or missing recovery-TD counts make this context null: offense/defense attribution and overlap are ambiguous. Do not add recovery TDs again or interpret missing defensive classification as zero. |

Missing or nonfinite numeric inputs become null and propagate through sums. Observed zero remains zero. `complete` means required comparison fields are present; it does not certify every source total against a gamebook. Optional touchdown context can remain null independently.

Joins canonicalize `OAK→LV`, `SD→LAC`, `STL/LAR→LA`, `JAC→JAX`, and `WSH→WAS`, without changing the source game ID or displayed historical schedule codes. Each retained game must have exactly two distinct, mutually matching team/opponent rows and matching home/away teams. Scores must exist. Unknown-team rows invalidate the entire game rather than silently omitting unattributed statistics.

Live aggregate profiles and this reference use the same field definitions. A PBP-derived profile can disagree because of compound penalties, fumble attribution or source corrections; do not label an approximate PBP profile as identical to an official aggregate profile.

## Actual coverage and exclusions

| Seasons | Included games | Scored schedule games | Explanation |
| --- | ---: | ---: | --- |
| 1999 | 257 | 259 | Missing `1999_01_BAL_STL`; unattributed stats in `1999_09_PHI_CAR`. |
| 2000 | 257 | 259 | Missing `2000_03_SD_KC`, `2000_06_BUF_MIA`. |
| 2001 | 251 | 259 | Eight Jacksonville home games lack a valid two-team aggregate pair. |
| 2002 | 259 | 267 | Eight Jacksonville home games lack a valid two-team aggregate pair. |
| 2003–2019 | 267 each | 267 each | All scored schedule games represented. |
| 2020 | 269 | 269 | All scored schedule games represented. |
| 2021 | 285 | 285 | All scored schedule games represented. |
| 2022 | 284 | 284 | All scored schedule games represented; canceled Buffalo–Cincinnati is absent from this schedule snapshot. |
| 2023–2025 | 285 each | 285 each | All scored schedule games represented. |

The artifact enumerates all 20 excluded game IDs and reasons. It does not impute or repair those games. All 14,512 included rows have present core comparison fields. Non-offensive-touchdown context is withheld when fumble-recovery TD attribution is ambiguous; the per-season `nullFields` records these counts. This completeness measure cannot detect every provider transcription error. In particular, the 2022 Super Bowl Kansas City aggregate has a fumble-recovery TD but zero classified defensive TDs, so its optional non-offensive-TD context is null rather than a false zero. The live finality guard separately withholds that game's whole profile when its scoring components fail to reconstruct the final score.

## Independent current-game verification

`models/game-profile-validation.json` contains two narrow real aggregate rows and their schedule row for `2026_02_GB_NYJ`, their normalized results, source URLs/checksums, and a linked official gamebook. **These 2026 rows are excluded from the historical reference.**

The [official Packers–Jets gamebook](https://static.clubs.nfl.com/image/upload/packers/zu3fdftopjkj8hkcwckc), pages 1 and 4, confirms September 20, 2026, Green Bay's 20–17 overtime win, net offense 199–285, penalties 14 for 133 yards versus 13 for 156, no interceptions, and lost fumbles 1–0. Thus Green Bay's turnover margin is −1. Both teams' two touchdowns were offensive. The aggregate normalization matches all these values. The PDF is linked, not redistributed.

Executed checks: all 28 compressed snapshots match their original-byte checksums; all historical team/game keys are unique; every row has a matching opponent with mirrored score, yards and turnover margin; the current-game fixture matches the gamebook; blank fields propagate to null; unknown-team rows exclude the game; historical aliases retain schedule codes; the offline rebuild reproduces identical artifact bytes.

## Data attribution

The compressed CSV snapshots, extracted fixture and transformed reference contain data from **nflverse / nflfastR**; schedules additionally credit **Lee Sharpe**. They retain the nflverse-data [CC BY 4.0 data license](https://raw.githubusercontent.com/nflverse/nflverse-data/main/LICENSE.md), with [license terms](https://creativecommons.org/licenses/by/4.0/). Modifications are compression, field selection, schedule joins, derived totals/margins, and documented exclusions. The repository's MIT software license does not replace this data license. No FTN data, team logos, broadcasts or gamebook copies are included in this reference.
