# Observed application results

Executed September 21, 2026 with source revision `173dbd4`. All eight real games completed the full application pipeline and their report routes returned HTTP 200. The existing modeled metrics in all seven baseline games were unchanged; the added outputs are the game-profile audit, observed context and review queue. Exact outputs and hashes are in [results.json](results.json).

## Packers example

`2026_02_GB_NYJ` is classified **Historical outlier**. Its actual aggregate totals are 199 offensive yards, 133 penalty yards, a −1 turnover margin and a 20–17 win. The final PBP and aggregate scoring/yardage reconcile.

- Under 200 offensive yards plus a negative turnover margin: **6 wins, 408 losses**, among 414 matching team-games in the 1999–2025 reference. That is about 1.45% observed wins, meeting the descriptive flag threshold.
- Adding at least 100 penalty yards: **0 wins, 14 losses**. This is shown prominently as a small historical sample, without a rarity label or probability claim.
- The denominator searched is **14,512 prior team-games / 7,256 games**. These counts do not support an all-time or pre-1999 record claim.
- The report shows the 63-yard GB punt return, two NYJ overtime sacks, NYJ's 156 penalty yards, and five plays selected for review. It identifies an unusual result while providing observed context for how it occurred.

## Disputed plays and comparisons

| Game | Audit result | Review candidates | Independently identified target surfaced |
| --- | --- | ---: | --- |
| 2012 GB–SEA, Fail Mary | Needs review | 4 | Yes: play 4153, final reviewed/upheld touchdown |
| 2014 DAL–GB, Bryant reversal | Needs review | 4 | Yes: play 3578 |
| 2018 LA–NO, missed interference | Needs review | 2 | Yes: play 4006, including a full source link despite no modeled event |
| 2022 KC–PHI, late holding | Needs review | 4 | Yes: play 3907 |
| 2023 DET–DAL, eligibility dispute | Needs review | 3 | Yes: play 4088 |
| 2023 MIA–BAL comparison | No configured historical outlier flag | 0 | No disputed target was assigned |
| 2024 KC–PHI comparison | Needs review | 3 | No disputed target was assigned |

All five targeted incidents now appear in the prominent review queue. The 2024 comparison's three candidates are genuine replay-reversed/nullified scoring descriptions, including two at a 34-point gap. This is evidence that the scan finds reviewable plays, **not** evidence that it measures public controversy accurately. Candidate count is not an overall controversy grade. Rules were motivated by these known cases; this is exploratory development evaluation, not held-out classifier performance.

The 2022 Super Bowl's aggregate scoring fields reconstruct KC 32 rather than 38 points; the aggregate also identifies a fumble-recovery touchdown whose attribution cannot be safely combined with other touchdown fields. The audit conservatively withholds both team profiles with `team_stats_score_mismatch`. Its play review queue remains available. Ambiguous fumble-touchdown attribution is null, not a false zero.

## Verification and release status

108 unit/integration tests and 18 desktop/mobile browser checks passed. Production web and local worker builds passed. The browser checks cover actual Packers counts, the Saints source-only candidate, immutable older revisions, mobile overflow, event/source links, authentication and hydration errors. No live social posts or manual correctness judgments were created.

The source is published; the updated application runs in the local private preview. The VPS release was not changed in this run: both official Hostinger read-only inspection calls timed out after 300 seconds. No shared VPS projects, containers, ports, secrets or DNS records were modified.
