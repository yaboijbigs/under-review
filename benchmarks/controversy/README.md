# Controversial-game benchmark

This is a fixed, deliberately selected case study of five famous disputed games and two comparison blowouts. The cohort was selected before inspecting application results. Comparison games are not established controversy-free controls. Seven cases cannot establish population accuracy or agreement with public sentiment, and public controversy is not proof of an incorrect ruling.

The application has no controversy classifier or validated overall score. This benchmark inspects whether the independently identified disputed play is retained in the timeline, selected as an event, modeled with a supported impact, included among the first 12 events, or linked to either headline finding. All plays must be matched by quarter, clock, and description before interpreting a match. A linked aggregate is not proof the headline describes that incident. No reviews are inserted and no model is fitted or changed to match the selected games.

## Case evidence

| Case | Date and final | Public dispute and evidence |
| --- | --- | --- |
| 2012 GB–SEA | September 24, 2012; SEA 14–12 | The final touchdown involved disputed possession and acknowledged missed offensive interference. [NFL explanation](https://amp.nfl.com/news/nfl-game-should-have-ended-on-golden-tate-penalty-0ap1000000066172). |
| 2014 DAL–GB divisional | January 11, 2015; GB 26–21 | Bryant's apparent catch was reversed under the contemporary catch rule. Controversy does not establish an officiating error. [Referee explanation](https://amp.nfl.com/news/referee-dez-bryant-catch-incomplete-once-ball-hit-ground-0ap3000000456973), [Packers account](https://www.packers.com/news/sam-shields-the-refs-made-a-good-call-14764767). |
| 2018 LA–NO conference championship | January 20, 2019; LA 26–23 OT | Missed pass interference at 1:49; the commissioner later acknowledged it. [Saints account](https://www.neworleanssaints.com/news/turning-point-of-the-game-in-new-orleans-saints-loss-to-rams), [Goodell acknowledgment](https://www.azcardinals.com/news/roger-goodell-fix-for-missed-calls-will-be-explored-but-solution-not-simple). |
| 2022 KC–PHI Super Bowl LVII | February 12, 2023; KC 38–35 | Late holding drew controversy; Bradberry acknowledged holding and the referee explained the call. [NFL report](https://amp.nfl.com/news/eagles-cb-james-bradberry-on-crucial-third-down-penalty-it-was-holding). |
| 2023 DET–DAL | December 30, 2023; DAL 20–19 | Eligibility reporting was disputed after a conversion was nullified at 0:23. [Players and referee accounts](https://www.detroitlions.com/news/four-downs-what-happened-on-two-point-conversion-penalty). |
| 2023 MIA–BAL comparison | December 31, 2023; BAL 56–19 | Same-week comparison. [Ravens game center](https://www.baltimoreravens.com/game-day/2023/reg-week17/dolphins-at-ravens/). |
| 2024 KC–PHI Super Bowl LIX comparison | February 9, 2025; PHI 40–22 | Championship-game comparison. [Eagles Super Bowl page](https://www.philadelphiaeagles.com/super-bowl-lix/). |

The year in a canonical game ID is its NFL season, not necessarily the calendar year of the game. The Bryant play's frozen provider clock is 4:42; possession after the review is described at 4:06 in contemporary reporting.

## Reproduce locally

Use the ordinary local configuration from the root README. Run off the shared VPS; the script refuses `VPS_STAGING=true` or enabled live posting. Start only the local database, build the pinned analytics image if it is not already available, and build the application worker:

```sh
npm ci
npm run local:init
docker compose up -d db
docker build -f analytics/Dockerfile -t under-review-analytics:local .
docker build -f Dockerfile.worker -t under-review-worker:benchmark .
docker compose -f compose.yaml -f benchmarks/controversy/compose.yaml run --rm --no-deps -T worker npm run ur -- migrate
docker compose -f compose.yaml -f benchmarks/controversy/compose.yaml run --rm --no-deps -T worker node --import tsx scripts/controversy-benchmark.ts /benchmark/cases.json /results
```

Create `data/controversy-benchmark` beforehand if the local Docker bind-mount policy requires it. Optionally set `BENCHMARK_SOURCE_COMMIT` to the checked-out Git revision. The harness records relevant code, model-file, cohort, source-snapshot and analysis-input hashes. It processes games sequentially at one CPU / 2 GiB, uses reconciled historical feeds, marks games as backfills, and renders only an in-memory social draft preview. It does not send posts or create review judgments.

Full reports and structured observations are written to ignored `data/controversy-benchmark/`. They remain available in the local application database at `/games/GAME_ID`. Reruns preserve immutable revisions and reuse identical inputs. Field `targetInHeadline` means linkage to a selected metric, not a correctness finding; `targetMetrics` includes both play and event linkage, while event cards render event-linked metrics.

## Historical finality regression

The first run rejected 2012 GB–SEA and 2018 LA–NO with `explicit_game_end_missing`. Both actual provider files already ended in an explicit `END GAME` row with the reconciled final score. Their optional `drive_end_transition` field was missing. Rebuilding the raw feed produced the same missing optional value.

The targeted fix accepts that absent metadata while retaining the explicit terminal record, valid terminal quarter, full scoring reconstruction, schedule-score agreement, identity, duplicate-play, and quarter-coverage checks. A present contradictory transition remains rejected. No game-end rows were invented, source data altered, model weights changed, or reviews inserted. Initial failures were preserved separately before rerunning the original seven cases.

Older cases also expose deliberate model limits: trained kicking/fumble/penalty baselines reject games at or before their calibration cutoff; FTN coverage begins later than the oldest games; category percentiles require a season later than the frozen 2024–2025 reference. Missing or unavailable values cannot be interpreted as an ordinary or uncontroversial game. Full third-party model training provenance is not established, so this retrospective case study is not a leakage-free held-out model evaluation.

Source data attribution and licenses remain in [DATA_SOURCES.md](../../DATA_SOURCES.md). Final observed results are recorded in [RESULTS.md](RESULTS.md).
