# Officiating algorithm experiment — release blocked

The recommendations are implemented as an end-to-end candidate, including the
worker, immutable revisions, report explanations, crew tables, feedback versioning
and tweet previews. **This candidate has not replaced the live algorithm.**
Container publication is blocked by `release-gate.json` and the publishing workflow.

## What was tested, in order

1. **Conditional called-penalty expectations.** Compare league-only, team/opponent,
   situational and crew-adjusted predictions. Choose the pooling strength from
   50/200/1,000 using chronological 2021–2023 predictions. The 1,000 setting won.
2. **Enforcement impact.** Fit signed expected points from earlier-season states.
   Compare supported actual enforcement with a documented alternative. Whole-play
   momentum is separate; an unsupported alternative is never assigned zero cost.
3. **Drive search.** Compare the strongest game or drive statistic with the same
   search in earlier games. No fixed two/three-penalty rating floors, no adding the
   same calls twice, and no treating an observed drive as an independent sequence.
4. **Crew effects.** Join all seven roles; exclude conflicting assignments from
   estimation. Test strictness adjustment and directional repeatability before
   deciding whether either belongs in the score.
5. **Consumer integration.** Make box score, spread and observed momentum context.
   Preserve old v1–v5 reports exactly; candidate reports use audit v6/rules v4.
6. **Reserved seasons and case inspection.** Freeze choices, evaluate complete
   2024 and 2025 regular seasons, then inspect all 32 completed 2026 Week 1–2 games.
   Do not change thresholds to reproduce a desired rating for a famous game.

The corpus contains all 2,895 completed regular-season games from 2015–2025.
Source-format corrections recovered annotated opening/ending records and aligned
relocated franchise names. All sources have immutable hashes. The cancelled 2022
BUF–CIN game is not a completed game and is not included.

## Results

| Component | 2024 | 2025 | Decision |
|---|---:|---:|---|
| Conditional penalty log loss versus league-only | 1.24% lower | 1.48% lower | Useful predictive improvement |
| EP mean squared error versus constant EP baseline | 10.30% lower | 11.78% lower | Useful state-value baseline; not a test of fairness |
| Experimental WP versus score/clock baseline | Improvement interval crosses zero | Improvement interval crosses zero | Withhold WP contrasts |
| Crew adjustment | Worse log loss | Worse log loss | Keep crew histories descriptive |
| Games with sufficient candidate coverage | 223/272 | 225/272 | Insufficient for a comprehensive overall rating |

The frequency and EP improvements have paired whole-game bootstrap intervals
excluding zero (5,000 seeded draws). These hold model fits fixed; they do not
measure uncertainty in training or call correctness. EP was compared with a
simple constant baseline, not claimed superior to nflfastR's established model.
The experimental WP model also showed substantial calibration errors. Existing
momentum models remain unchanged.

Directional crew residuals had correlation **−0.042** across disjoint historical
periods (75 officials meeting support requirements). That does not establish that
all officials are unbiased; it does not justify a predictive directional adjustment.

Only **1,857 of 5,541 accepted penalties (33.5%)** were valued in the reserved
seasons. **96 of 544 games (17.6%)** were unrated. Some exclusions represent
declined/offsetting or multiple-penalty descriptions that cannot be separated
reliably, not necessarily corrupt source data. Week 2 of 2026 has no verified full
crew assignments in the frozen release; these are shown as missing.

## Why promotion stopped

| Current-season example | Previous reconstructed rating | Candidate | What inspection revealed |
|---|---|---|---|
| 2026 Week 1 GB–MIN | Sus, 4/5 | Fair, 1/5 | Only one of three known stop-extending penalties on the highlighted drive has a supported value. An ordinary subset is not a sound basis for reassuring users about the whole drive. |
| 2026 Week 2 GB–NYJ | Sus, 4/5 | Debatable, 2/5 | Removing box-score surprise as a rating driver changes the result; six of eighteen accepted penalties are valued. |
| 2026 Week 2 DET–BUF | Hmm, 3/5 | RIGGED?, 5/5 | Two valued calls gave Detroit substantial scoring opportunity while trailing by 17. Large EP impact is not the same as decisive influence on the result. |

The candidate rates 27 of 32 current games. Neutralizing one modeled contribution
changes seven ratings; five fall to Fair. This sensitivity holds opportunity
expectations, variance, coverage and historical calibration fixed. It is not a
replay of what the game would have been without a call. Dependence on one major
call is not inherently an error, but it matters when labeling an entire game.

These are **construct-validity failures**, not reasons to tune the model until
GB–MIN gets a preferred score. The calculation measures the unusual impact of a
selectively reconstructable subset of enforcement. It does not yet support the
product's overall Fair/Sus interpretation. No new tweets, rescoring of live
reports, VPS changes or public rollout were performed.

## What should happen before release

- Define a missing-evidence rule for known stop-extending penalties whose impact
  cannot be reconstructed. An ordinary subset must not imply a fair whole game.
- Evaluate conditional called-penalty and drive-extension patterns directly,
  rather than requiring a defensible EP alternative for every counted event.
  This would be a new model, not a post-hoc count floor.
- Separate scoring-opportunity impact from influence in a competitive game.
  Do not replace that distinction with the rejected experimental WP estimates.
- Freeze any revised design before another evaluation. The 2024–2025 results and
  these 2026 cases have now been inspected and cannot be presented as untouched
  validation for a later redesign.

The useful work remains reusable: conditional rate models, conservative state
extraction, full crew joins, provenance, chronological evaluation, consumer
versioning and arithmetic/integration checks.

## Reproduction and evidence

See [README](README.md) for the checksum-verified corpus build. Then run:

```powershell
node --import tsx scripts/evaluate-officiating-frequency.ts
# Freeze prior=1000 and crewAdjustment=false in data/officiating-evaluation/selection.json.
node --import tsx scripts/evaluate-officiating-impact.ts --through=2026
node --import tsx scripts/summarize-officiating-evaluation.ts --through=2026
node --import tsx scripts/evaluate-officiating-stability.ts
node --import tsx scripts/build-officiating-reference.ts --write
node --import tsx scripts/export-officiating-evaluation.ts
```

[Machine-readable results](results.json) include model hashes, year-by-year
diagnostics, all current-game comparisons and sensitivity results. Historical
baseline ratings are reconstructed from frozen aggregate data and compact
extension evidence; they are not retrieved production revisions. Full raw caches
stay outside Git. The checked-in public fixture reproduces one report from actual
source rows, and the fitted reference contains no operational credentials.
