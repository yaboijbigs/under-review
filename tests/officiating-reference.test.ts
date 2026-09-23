import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Game } from '../packages/core/src/contracts.js';
import type { ProviderRow } from '../packages/core/src/normalize.js';
import { OFFICIATING_REFERENCE_VERSION, validOfficiatingAudit } from '../packages/core/src/officiating-contracts.js';
import { FREQUENCY_VERSION, type FrequencyModel } from '../packages/core/src/officiating-frequency.js';
import { calculateGameImpact } from '../packages/core/src/officiating-impact.js';
import type { OfficiatingGameObservation, OfficiatingOpportunity } from '../packages/core/src/officiating-observations.js';
import { buildOfficiatingAudit, loadOfficiatingReference, normalizeOfficiatingRows, OFFICIATING_REFERENCE_PARAMETERS, OFFICIATING_TEAM_ALIASES, officiatingObjectChecksum, officiatingReferenceChecksum, officiatingSourceKeys, validOfficiatingReference, verifyOfficiatingPrediction, type OfficiatingReference } from '../packages/core/src/officiating-reference.js';
import { fitStateModel } from '../packages/core/src/officiating-state-model.js';

const directory = await mkdtemp(path.join(os.tmpdir(), 'under-review-officiating-reference-'));
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const sha = 'a'.repeat(64), heads = ['offensive_hold:o', 'defensive_pass:d', 'offensive_presnap:o', 'defensive_presnap:d', 'personal_foul:o', 'personal_foul:d', 'other_offense:o', 'other_defense:d'];
const years = Array.from({ length: 12 }, (_, i) => 2015 + i);
// Deliberately synthetic training/calibration fixtures exercise integrity and arithmetic, not football claims.
function training(year: number): OfficiatingGameObservation[] {
  return Array.from({ length: 100 }, (_, index) => {
    const opportunities: OfficiatingOpportunity[] = Array.from({ length: 80 }, (_, p) => ({ playId: String(p), order: p, driveId: '1',
      state: { possessionTeam: 'KC', defenseTeam: 'OAK', quarter: 2, down: p % 4 + 1, yardsToGo: 10, yardline100: 15 + 10 * (Math.floor(p / 4) % 8), halfSecondsRemaining: 600, gameSecondsRemaining: 2400, scoreDifference: 0, possessionTimeouts: 3, defenseTimeouts: 3, receivesSecondHalfKickoff: 1 },
      playKind: 'run', penaltyStatus: 'none', penalty: null, penaltyExclusionReason: null, observedHomeWpChange: null, labels: { nextScore: 3, homeWin: .5 } }));
    return { schemaVersion: 1, gameId: `synthetic-${year}-${index}`, season: year - 5 + index % 5, week: 1, gameType: 'REG', homeTeam: 'KC', awayTeam: 'OAK', opportunities,
      coverage: { inputRows: 80, uniqueRows: 80, duplicateRows: 0, conflictingPlayIds: 0, excludedRows: {}, regulationOpportunities: 80, overtimeOpportunities: 0, unknownPlayKind: 0, incompleteStates: 0, acceptedPenalties: 0, excludedPenalties: 0, valuedStatePairs: 0, valuationExclusions: {}, nextScoreLabels: 80, missingNextScoreLabels: 0 } };
  });
}
function makeReference(): OfficiatingReference {
  const sourceChecksums = Object.fromEntries(years.flatMap(officiatingSourceKeys).map(key => [key, sha]));
  const seasons: OfficiatingReference['seasons'] = {};
  for (let year = 2023; year <= 2026; year++) {
    const state = fitStateModel(year, training(year));
    const frequency: FrequencyModel = { version: FREQUENCY_VERSION, targetSeason: year, trainingSeasons: Array.from({ length: 5 }, (_, i) => year - 5 + i), games: 500, prior: 1000, base: Object.fromEntries(heads.map(head => [head, [10000, 100]])), coarse: {}, context: {}, teams: {}, opponents: {}, crew: {} };
    const impact = { targetSeason: year, stateModelChecksum: state.checksum, heads: Object.fromEntries(heads.map(head => [head, [100, 100, 100, 100] as [number, number, number, number]])), contexts: {} };
    seasons[String(year)] = { frequency, state, impact, modelChecksums: { frequency: officiatingObjectChecksum(frequency), state: state.checksum, impact: officiatingObjectChecksum(impact) },
      calibration: Array.from({ length: 3 }, (_, j) => year - 3 + j).flatMap(season => Array.from({ length: 200 }, (_, i) => ({ gameId: `${season}_01_${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}_ZZZ`, season, maximum: i / 100, gameStatistic: i / 200 }))),
      crewAssignments: { [`${year}_01_OAK_KC`]: { status: 'missing', roles: [] } }, sourceChecksums: Object.fromEntries(Object.entries(sourceChecksums).filter(([key]) => Number(key.split(':')[0]) >= year - 8 && Number(key.split(':')[0]) <= year)) };
  }
  const reference: OfficiatingReference = { schemaVersion: 1, version: OFFICIATING_REFERENCE_VERSION, license: 'CC-BY-4.0', attribution: 'Synthetic test fixture', parameters: { ...OFFICIATING_REFERENCE_PARAMETERS }, teamAliases: { ...OFFICIATING_TEAM_ALIASES }, seasons,
    provenance: { corpusChecksums: Object.fromEntries(years.map(year => [String(year), sha])), sourceChecksums, inputCodeChecksums: Object.fromEntries(['officiating-observations', 'officiating-frequency', 'officiating-state-model', 'officiating-impact', 'officiating-calibration', 'officiating-contracts'].map(name => [name, sha])), evaluationChecksum: sha }, checksum: '' };
  reference.checksum = officiatingReferenceChecksum(reference);
  return reference;
}
const reference = makeReference();
let serial = 0;
async function load(value: OfficiatingReference) {
  const file = path.join(directory, `${serial++}.json`), bytes = JSON.stringify(value) + '\n';
  await writeFile(file, bytes);
  return { loaded: await loadOfficiatingReference(file), bytes };
}
const game: Game = { id: '2026_01_OAK_KC', season: 2026, week: 1, gameType: 'REG', homeTeam: 'KC', awayTeam: 'OAK', homeScore: 0, awayScore: 0, kickoffAt: null, providerData: { result: 0 } };
function gameRows(plays = 80): ProviderRow[] {
  const common = { game_id: game.id, season: 2026, home_team: 'KC', away_team: 'LV', total_home_score: 0, total_away_score: 0 };
  return [{ ...common, play_id: 1, qtr: 1, desc: 'GAME' }, ...Array.from({ length: plays }, (_, i) => {
    const qtr = Math.min(4, 1 + Math.floor(i / (plays / 4))), half_seconds_remaining = qtr % 2 ? 1200 : 600;
    return { ...common, play_id: i + 2, qtr, posteam: 'LV', defteam: 'KC', down: 1, ydstogo: 10, yardline_100: 50, half_seconds_remaining, game_seconds_remaining: half_seconds_remaining + (qtr <= 2 ? 1800 : 0), score_differential: 0, posteam_timeouts_remaining: 3, defteam_timeouts_remaining: 3, home_opening_kickoff: 1, fixed_drive: 1 + Math.floor(i / 8), play_type: 'run', desc: 'Runner up the middle for no gain.' };
  }), { ...common, play_id: plays + 2, qtr: 4, desc: 'END GAME', drive_end_transition: 'END_GAME' }];
}

describe('frozen officiating reference integrity', () => {
  it('rejects a numerically valid edited calibration maximum before the builder seals it', () => {
    const models = reference.seasons['2026'], observation = { ...training(2026)[0], season: 2026, gameId: '2026_01_OAK_KC' };
    const saved = calculateGameImpact(observation, models.frequency, models.state, models.impact);
    expect(verifyOfficiatingPrediction(observation, models, saved).maximum).toBe(saved.maximum);
    expect(() => verifyOfficiatingPrediction(observation, models, { ...saved, maximum: saved.maximum + 1 })).toThrow('does not reproduce');
  });
  it('loads file hashes, verifies all model payloads, and deeply freezes prepared state fits', async () => {
    expect(validOfficiatingReference(reference)).toBe(true);
    const { loaded, bytes } = await load(reference);
    expect(loaded.checksum).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Object.isFrozen(loaded.reference.seasons['2026'].state.ep.coefficients)).toBe(true);
    expect(Object.isFrozen(loaded.reference.seasons['2026'].frequency.base)).toBe(true);
    expect(() => { loaded.reference.seasons['2026'].frequency.games = 1; }).toThrow();
  });
  it.each(['state_payload', 'frequency_payload', 'target_cutoff', 'duplicate_calibration', 'future_calibration', 'missing_provenance', 'ambiguous_crew', 'alias_drift'] as const)('rejects %s even after recomputing the outer checksum', async kind => {
    const changed = structuredClone(reference), entry = changed.seasons['2026'];
    if (kind === 'state_payload') entry.state.ep.coefficients![0] += 1;
    if (kind === 'frequency_payload') { entry.frequency.base['offensive_hold:o'][1] = 20000; entry.modelChecksums.frequency = officiatingObjectChecksum(entry.frequency); }
    if (kind === 'target_cutoff') { entry.frequency.trainingSeasons[4] = 2026; entry.modelChecksums.frequency = officiatingObjectChecksum(entry.frequency); }
    if (kind === 'duplicate_calibration') entry.calibration.push(entry.calibration[0]);
    if (kind === 'future_calibration') { entry.calibration[0].season = 2026; entry.calibration[0].gameId = '2026_01_AAA_BBB'; }
    if (kind === 'missing_provenance') delete changed.provenance.sourceChecksums[officiatingSourceKeys(2015)[0]];
    if (kind === 'ambiguous_crew') entry.crewAssignments[game.id] = { status: 'complete', roles: [{ role: 'Referee', name: 'Example Official' }] };
    if (kind === 'alias_drift') changed.teamAliases.OAK = 'KC';
    changed.checksum = officiatingReferenceChecksum(changed);
    expect(validOfficiatingReference(changed)).toBe(false);
    await expect(load(changed)).rejects.toThrow('Invalid officiating reference');
  });
});

describe('runtime observations and fail-closed scoring', () => {
  it('uses the corpus franchise mapping without changing the historical game identity', async () => {
    const { loaded } = await load(reference), rows = gameRows(), normalized = normalizeOfficiatingRows(game, rows);
    expect(rows[1].posteam).toBe('LV'); expect(normalized[1].posteam).toBe('OAK');
    const audit = buildOfficiatingAudit(game, rows, loaded);
    expect(audit.status).toBe('supported'); expect(validOfficiatingAudit(audit)).toBe(true);
    expect(audit.result?.rates.some(rate => rate.team === 'OAK')).toBe(true);
    expect(audit.result?.rates.some(rate => rate.team === 'LV')).toBe(false);
    expect(audit.crew).toEqual({ status: 'missing', adjustmentApplied: false, roles: [] });
  });
  it('withholds ratings for an unavailable season, truncated final data, and mixed game identities', async () => {
    const { loaded } = await load(reference);
    expect(buildOfficiatingAudit({ ...game, id: '2027_01_OAK_KC', season: 2027 }, [], loaded)).toMatchObject({ status: 'unavailable', reasonCode: 'officiating_season_unavailable', result: null });
    expect(buildOfficiatingAudit(game, gameRows().slice(0, -1), loaded)).toMatchObject({ status: 'unavailable', reasonCode: 'incomplete_final_game_data', result: null });
    const mixed = gameRows(); mixed[10].home_team = 'NE';
    expect(buildOfficiatingAudit(game, mixed, loaded)).toMatchObject({ status: 'unavailable', result: null });
  });
  it('returns limited evidence rather than a supported rating for insufficient calibration or coverage', async () => {
    const changed = structuredClone(reference); changed.seasons['2026'].calibration = []; changed.checksum = officiatingReferenceChecksum(changed);
    const { loaded } = await load(changed), audit = buildOfficiatingAudit(game, gameRows(), loaded);
    expect(audit).toMatchObject({ status: 'limited', reasonCode: 'insufficient_chronological_calibration', calibration: { tailProbability: null } });
    expect(validOfficiatingAudit(audit)).toBe(false);
    const original = (await load(reference)).loaded;
    expect(buildOfficiatingAudit(game, gameRows(12), original)).toMatchObject({ status: 'limited', reasonCode: 'insufficient_regulation_opportunity_coverage' });
  });
  it('rejects a caller-constructed object that did not pass the reference loader', () => {
    expect(buildOfficiatingAudit(game, gameRows(), { reference, checksum: sha })).toMatchObject({ status: 'unavailable', reasonCode: 'invalid_officiating_reference', result: null });
  });
});

const publishedPath = path.resolve('packages/core/reference/officiating-reference.json');
it('reproduces the frozen public Vikings–Packers game prediction through production inference', async () => {
  const fixture = JSON.parse(await readFile('tests/fixtures/officiating-game.json', 'utf8'));
  const loaded = await loadOfficiatingReference(publishedPath), audit = buildOfficiatingAudit(fixture.game, fixture.plays, loaded);
  expect(audit.gameId).toBe('2025_12_MIN_GB'); expect(audit.status).toBe('supported'); expect(validOfficiatingAudit(audit)).toBe(true);
  const expected = loaded.reference.seasons['2026'].calibration.find(game => game.gameId === fixture.game.id);
  expect(expected).toBeDefined();
  expect(audit.result?.maximum).toBeCloseTo(expected!.maximum, 10);
  expect(audit.result?.game.statistic).toBeCloseTo(expected!.gameStatistic, 10);
  expect(fixture.license).toBe('CC-BY-4.0');
  expect(fixture.sources.playByPlay.checksum).toBe(loaded.reference.provenance.sourceChecksums[officiatingSourceKeys(2025)[0]]);
  expect(fixture.sources.schedule.checksum).toBe(loaded.reference.provenance.sourceChecksums[officiatingSourceKeys(2025)[1]]);
});
