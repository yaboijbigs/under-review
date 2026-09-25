# Sequential officiating-model evaluation

No stage is enabled in production until its evaluation and integration checks pass.

## Frozen design

- Preserve audit v5 / suspicion v3 for historical reports and comparisons.
- Use 2015–2025 regular-season play-by-play, frozen schedules and official
  assignments. Retain source hashes and exclusions.
- Develop on chronological predictions through 2023. Reserve complete 2024 and
  2025 seasons for final retrospective evaluation, without threshold tuning to
  their results. Current 2026 games are case studies, never training inputs.
- Fit each prediction using earlier seasons. Calibrate on earlier games that
  were themselves predicted using their own earlier seasons.
- Keep evaluation independent of databases, production and publication jobs.
- Evaluate predictive loss, coverage, rating changes, missing inputs and
  stability. Alert frequencies are not misconduct false-positive rates.

## Stages

1. Conditional penalty opportunities versus league/team baselines.
2. Signed enforcement impact from supported actual/alternative states.
3. Calibrated drive sequences replacing fixed two/three-flag escalation.
4. Verified crew roles, strictness and directional repeatability. Predictive
   adjustments must improve later-season performance to be enabled.
5. Outcome/spread context only; versioned consumer scoring and integration.
6. Complete-season evaluation, sensitivity checks and bounded refresh.

## Decisions

### Foundation checks

- Historical team codes differ between PBP and schedules. Corpus extraction maps
  franchise aliases to each game's schedule identities instead of dropping games.
- Annotated `END GAME` records initially excluded 11 New England home games.
  The anchored terminal marker and matching final scores recover those games.
- Missing `GAME` opening records are accepted only with an observed opening
  kickoff at the start of Q1 and the appropriate score/clock consistency checks.
- Nullified kicking plays no longer enter scrimmage opportunity denominators.
- Presnap rate models never condition on the whistle-induced unknown play kind.
- Excluded/ambiguous penalties are not treated as clean negative labels.

The first development frequency run selected the strongest pooling option (1,000
opportunities) from the prespecified 50/200/1,000 grid. Contextual log loss improved
about 1.2–1.3% over league-only rates in each 2021–2023 season. These preliminary
numbers are being rerun after the source-completeness corrections. The crew
strictness adjustment improved two development seasons and worsened the third;
it remains disabled pending the complete evaluation.

### Impact guardrails found during review

- Sparse/absent historical valued-call support cannot supply zero expected cost
  while allowing positive observed impact.
- Structurally unvalued late-half states cannot inherit ordinary-period costs.
- Event valuation and historical costs must use the same state-model checksum.
- Only regulation contributes to regulation coverage fractions.
- Crew repeatability requires disjoint training seasons.
- Whole-game and strongest-drive effects are compared through one empirical
  maximum, not added as independent corroboration. This describes the observed
  game path; it is not a probability of a no-penalty alternative game.

Final stage results are recorded in [RESULTS.md](RESULTS.md). Promotion is blocked:
the selectively valued enforcement subset does not support an overall fairness
interpretation, and large EP benefits can occur in low-leverage situations. The
live deployment is unchanged. The complete candidate remains on its review branch.
