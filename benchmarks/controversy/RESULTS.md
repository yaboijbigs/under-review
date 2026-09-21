# Controversial-game results — September 21, 2026

**The automatic reports do not yet reliably surface the incidents that made these games controversial.** The application produces impact estimates and coverage records, not a controversy grade. In this fixed five-case set, all five disputed plays are present in the source timeline, four become evidence events, none has a supported estimate of the disputed ruling's impact, and none appears in either headline finding or the first 12 event cards. Every report correctly remains **not reviewed** for officiating correctness.

This is a case-study result, not classifier accuracy. Public controversy and incorrect officiating are different labels: the official contemporary explanation supported the Dez reversal, and Bradberry acknowledged holding. The source evidence and preselected cohort are in [README.md](README.md).

## What the application actually did

| Game / focal incident | Exact provider play | Automatic treatment | Headline treatment |
| --- | --- | --- | --- |
| 2012 GB–SEA, Fail Mary | `4153`, Q4 0:08 | Fourth-down event, display position 43. Impact unavailable: `outside_fourth_down_domain`. | The +17.6 percentage-point Seattle finding is an earlier **6:14 defensive pass-interference penalty**, not the final catch or missed offensive interference. |
| 2014 DAL–GB, Dez reversal | `3578`, Q4 4:42 | Fourth-down event, position 29. Experimental zero coaching cost with `empirical_scenario_unavailable`; this does not assess the catch ruling. | −8.7 percentage points for Green Bay concerns a **Q1 1:14 pass-interference penalty**, not the disputed reversal. |
| 2018 LA–NO, missed interference | `4006`, Q4 1:49 | Timeline only. No penalty flag means no automatic officiating event or impact metric. | Highlights a **5:16 delay-of-game penalty** and an earlier fourth-down decision. |
| 2022 KC–PHI, Bradberry holding | `3907`, Q4 1:54 | Penalty event, position 30. Impact unavailable: `clock_or_period_ambiguity`. | Highlights a different penalty and coaching decision. |
| 2023 DET–DAL, nullified Decker conversion | `4088`, Q4 0:23 | Penalty event, position 31. Impact unavailable: `multiple_or_unparsed_penalties`. | Highlights a different penalty and coaching decision. |

“Position” is the current UI ordering, not a calibrated severity rank. Events without supported local WP estimates fall behind modeled events and retain their input order. The four recorded incidents remain reachable in the expandable evidence archive; they are not deleted. The Saints no-call cannot appear in that archive until a candidate is supplied through a review workflow or a separate detection method.

The first two cases show why direction alone is insufficient validation. A report favoring Seattle can resemble the broad public narrative while measuring an entirely different incident. The reported WP deltas concern modeled ruling consequences; they do not establish incorrect calls, intentional misconduct, or an alternative winner.

## Comparison games

The preselected 2023 Miami–Baltimore game (Baltimore 56–19) still produced supported coaching and penalty findings: 1.6 percentage points of Baltimore decision cost and a −0.1-point Baltimore ruling consequence. The 2024 Kansas City–Philadelphia Super Bowl (Philadelphia 40–22) produced a −2.7-point Philadelphia ruling consequence and 2.5-point Kansas City decision cost.

Thus the presence of findings alone cannot mean “controversial.” These two blowouts are illustrative comparisons, not matched negative controls or proof that those games contained no disputed calls. Their score margins, eras, and game situations differ from the selected disputed games.

## Executed checks and preserved limitations

- All seven games completed locally using reconciled provider data and the same frozen analytics models. Canonical NFL season IDs were used for January/February games. No VPS workload or deployment was changed.
- All seven saved game pages returned HTTP 200 in the local production web preview. TypeScript checking and the focused ingestion regression suite passed.
- The initial run rejected Fail Mary and Saints–Rams because optional terminal-drive metadata was absent despite explicit `END GAME` records. A targeted ingestion fix preserved every source row and all other completeness/score checks; 20 focused ingestion tests passed. The initial failures were preserved in `data/controversy-benchmark/before-ingestion-fix.json` before the same cohort was rerun.
- Each focal incident was matched to exactly one source play by quarter, clock, and description. No manual candidates, human reviews, or social posts were added. Social output was rendered only as an in-memory draft preview.
- The cohort and three recorded model-artifact checksums stayed identical across runs. Previously successful games retained their existing input hashes and revisions; the fix did not change their findings. Relevant code hashes distinguish the tested local validation fix from the base release.
- All seven cases have unavailable category rarity percentiles, and the application has no validated overall percentile. Most cases predate the trained baselines' calibration cutoff; all predate the end of the frozen 2024–2025 category reference period. Missing estimates do not imply ordinary games. Older games also lack FTN coverage.
- Contemporary public sources document the controversies, but they are not a representative sentiment survey. Third-party model provenance also prevents calling this a leakage-free held-out statistical evaluation.

Machine-readable observations are in [results.json](results.json). Full local report exports and original source-snapshot hashes remain in ignored `data/controversy-benchmark/`; reports are also stored in the local application's database. Source-data attribution and licenses are documented in [DATA_SOURCES.md](../../DATA_SOURCES.md).

## What this suggests changing next

Add a separate **Needs review** queue for consequential but unmodeled incidents, including replay reversals, nullified scores, and late-game penalties. Its priority should explicitly represent review urgency, not a finding that a call was wrong or an unsupported estimate of its effect. No-calls and disputed reporting facts still need evidence-backed manual candidates. The existing human-review workflow can then preserve rule-season context, disagreement, scope, and approval.

Evaluate that queue on a larger independently labeled set with matched close games and separate labels for public controversy, acknowledged errors, defensible disputed calls, and missing coverage. Do not tune the quantitative models merely to reproduce outrage about these five famous cases.
