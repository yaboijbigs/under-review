# Officiating evaluation corpus

`scripts/build-officiating-corpus.ts` builds compact observations from public nflverse play-by-play. The corpus contains completed regular-season games from 2015–2025 and a separate 2026 target snapshot. Parsing the held-out seasons does not fit models or select thresholds; the evaluation runner controls chronological training and holdouts.

```powershell
# Offline after sources have been cached:
node --import tsx scripts/build-officiating-corpus.ts

# Explicitly download missing public CSVs, retaining checksummed local bytes:
node --import tsx scripts/build-officiating-corpus.ts --download-missing

# Rebuild selected seasons after an extractor change:
node --import tsx scripts/build-officiating-corpus.ts --seasons=2020-2023

# Refresh only public current-season PBP and schedules; preserve previous bytes:
node --import tsx scripts/build-officiating-corpus.ts --seasons=2026 --refresh-current-public
```

The builder searches checksum-verified `data/snapshots` indexes, then `data/overtime-sources` using hashes from the frozen overtime reference, then its own `data/officiating-sources` cache. Network access is disabled unless `--download-missing` or the explicit current-season `--refresh-current-public` flag is present. Current-season refreshes take precedence over older stored snapshots on subsequent offline builds. Downloads use only public nflverse GitHub release URLs and are committed atomically to the cache with URL, retrieval time, HTTP metadata, byte count, and SHA-256. Refreshing updates metadata pointers but never overwrites checksum-addressed source bytes. Source data revisions remain visible through their distinct checksums. The source helper also exposes the same explicit refresh for current public team statistics when a comparison runner needs them.

Historical schedules are the checksum-named archive in `analytics/models/game-profile-sources` identified by `game-profiles.json`. The 2026 target uses the locally cached, checksum-verified public schedule snapshot. A game requires schedule final scores, consistent score margin, an explicit play-by-play `END GAME` marker (allowing provider notes after the marker), matching terminal scores and team/season identity, all regulation quarters, and unique play IDs. The shared extractor's `hasVerifiedGameOpening` validates the start: an unannotated `GAME` with observed 0–0, or an explicit first action kickoff in quarter 1 at 3,600 game seconds with pre-play scores 0–0 and any preceding intro rows also reporting 0–0. Annotated or absent opening markers handled through the latter evidence are counted as `openingKickoffVerifiedGames`; no synthetic row is inserted. Modern franchise codes in historical play-by-play are mapped back to the corresponding schedule team's name using the existing project aliases. Exclusions are recorded; missing games are not silently treated as penalty-free games. This is a corpus completeness gate, not a judgement of whether a recorded call was correct. Schedule metadata and final results are retained for labels, provenance, and comparisons; the extractor/model must select pre-play predictors explicitly.

Officials are joined from the frozen `packages/core/reference/expectations-officials.csv.gz` to schedule `gsis` using officials `game_key`, never the date-form game ID. The source hash is verified. The seven on-field roles are retained: Referee, Umpire, Down Judge, Line Judge, Field Judge, Side Judge, and Back Judge. Historical Head Linesman becomes Down Judge. Names use the existing documented expectations-reference aliases. Replay and alternate officials are excluded. Duplicate roles with different names, schedule/referee disagreement, identity mismatches, or one person occupying multiple roles produce `crewStatus: "conflict"`; affected roles are withheld, and known other roles remain context. Partial and absent assignments are explicit. A schedule-only referee is not invented into a full crew. These are assignments, not individual flag attribution.

Each ignored `data/officiating-corpus/season-YYYY.json.gz` holds:

```text
{
  schemaVersion, season, extractorChecksum, builderChecksum, aliasesChecksum, teamAliases, license,
  sources: { playByPlay, schedule, officials },
  counts, excludedOfficialRows, exclusions,
  games: [{
    game, observation, crew: [{ role, name }], crewStatus, crewIssues,
    playCount, source: { playByPlayChecksum, scheduleChecksum, officialsChecksum }
  }]
}
```

Rows stream one game at a time, preserving provider chronology and setting `source_order`. Non-contiguous repeated game IDs fail rather than silently truncating games. Observations come from the shared production extractor `extractOfficiatingObservation`; its source checksum and the builder checksum guard against stale cached observations. Games are ordered by kickoff, week, and ID. A companion `season-YYYY.metadata.json` records counts, exclusions, input provenance, and the SHA-256 of the uncompressed JSON. `readOfficiatingCorpus(root, seasons)` in `scripts/lib/officiating-sources.ts` verifies those hashes before returning games in chronological order. Output files are atomically replaced. The existing `data/` ignore rule keeps raw data and full observation artifacts outside Git.

Initial inspection caught systematic source differences before evaluation: modern franchise codes inside older game IDs would otherwise exclude relocated teams; 11 New England home games had provider notes appended to `END GAME`; and seven Jacksonville home games per season in 2015–2018 had annotated opening markers. Explicit alias mapping, anchored terminal-marker recognition, and verified opening kickoffs preserve these valid games without weakening final-score checks. The builder and shared extractor use the same opening evidence, preserving valid state-model labels as well as frequency observations. Missing or conflicted crew assignments never cause a whole game to be dropped.

The September 23, 2026 build includes all **2,895 completed 2015–2025 regular-season games**, **508,914 source play rows**, and **386,210 extracted opportunities**. All 383,685 regulation opportunities have next-score labels; overtime observations remain separate. There are no game exclusions. Historical crews are complete for 2,868 games, partial for 12, and conflicting for 15. The refreshed 2026 snapshot includes **32 games**, 16 in each of Weeks 1 and 2, with 5,489 play rows and 4,163 opportunities. Only the 16 Week 1 games have full crew assignments in the frozen officials feed; Week 2 crew data remains explicitly unavailable. The target artifact rebuilt offline with the identical uncompressed checksum `4246d2ee17e86d885bcb4b7ec2d29d93d88531f28ab4675b2a3c3a748402c14e`.

Data attribution: **nflverse / nflfastR**, schedules additionally **Lee Sharpe**, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See the [nflverse data license](https://github.com/nflverse/nflverse-data/blob/main/LICENSE.md). These historical feeds are frozen provider revisions, not reconstructed contemporaneous publications; chronological model fitting prevents target-season outcome leakage but does not recreate earlier data vintages. No private files, production services, or posting credentials are accessed by this builder.
