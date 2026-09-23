import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CorpusGame } from '../build-officiating-corpus.js';
import type { Game, GameProfile, SourceSnapshot } from '../../packages/core/src/contracts.js';
import { getGameRatingBreakdown, getGameVerdict, type GameRatingFamilyBreakdown } from '../../packages/core/src/consumer-summary-v3.js';
import { buildGameAudit } from '../../packages/core/src/game-audit.js';
import { buildExpectations, loadExpectationsReference } from '../../packages/core/src/expectations.js';
import { loadGameProfileReference, normalizeGameProfiles } from '../../packages/core/src/game-profile-source.js';
import { parseCsv, type ProviderRow } from '../../packages/core/src/normalize.js';
import { buildMarketAudit, loadSpreadReference } from '../../packages/core/src/spread.js';
import { currentPublicSource, storedSnapshot } from './officiating-sources.js';

const scheduleUrl = 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv';
const aliases: Record<string, string> = { OAK: 'LV', SD: 'LAC', STL: 'LA', LAR: 'LA', JAC: 'JAX', WSH: 'WAS' };
const canonicalTeam = (team: string): string => aliases[team] ?? team;

export interface ReconstructedBaseline {
  rating: 1 | 2 | 3 | 4 | 5 | null;
  label: string;
  reason: string;
  statFamilies: GameRatingFamilyBreakdown[];
  driveCount: number;
  coverage: {
    profileSource: 'frozen_game_profiles' | 'stored_team_stats' | 'unavailable';
    profileSourceChecksum: string | null;
    profiles: number;
    extensionPlays: number;
    extensionPlaysWithDrive: number;
    missingDriveExtensions: number;
    excludedPenalties: number;
    sourceOpportunities: number;
  };
  notes: string[];
}

/** Convert only retained factual extension observations back to the old audit's input shape.
 * These records must never be used as play-by-play or as inputs to a fitted model.
 */
function extensionEvidence(entry: CorpusGame): { plays: ProviderRow[]; withDrive: number; maxDrive: number } {
  const plays: ProviderRow[] = [], groups = new Map<string, number>();
  let withDrive = 0;
  for (const opportunity of entry.observation.opportunities) {
    const penalty = opportunity.penalty, state = opportunity.state;
    if (opportunity.penaltyStatus !== 'accepted' || !penalty?.firstDownExtension) continue;
    const row: ProviderRow = {
      game_id: entry.game.id, play_id: opportunity.playId, qtr: state.quarter,
      posteam: state.possessionTeam, defteam: state.defenseTeam, down: state.down,
      penalty: 1, first_down_penalty: 1, first_down_pass: 0, first_down_rush: 0,
      penalty_team: penalty.team, penalty_type: penalty.type,
      desc: `PENALTY on ${penalty.team}, ${penalty.type}.`,
    };
    const drive = opportunity.driveId?.match(/^(fixed_drive|drive):([1-9]\d*):([A-Z]{2,3})$/);
    if (drive && drive[3] === state.possessionTeam) {
      row[drive[1]] = Number(drive[2]); withDrive++;
      groups.set(opportunity.driveId!, (groups.get(opportunity.driveId!) ?? 0) + 1);
    }
    plays.push(row);
  }
  return { plays, withDrive, maxDrive: groups.size ? Math.max(...groups.values()) : 0 };
}

function gameAliases(profile: GameProfile, game: Game): GameProfile {
  const rename = (name: string): string => canonicalTeam(name) === canonicalTeam(game.homeTeam) ? game.homeTeam
    : canonicalTeam(name) === canonicalTeam(game.awayTeam) ? game.awayTeam : name;
  return { ...profile, team: rename(profile.team), opponent: rename(profile.opponent) };
}

/** Offline reconstruction of the pre-overhaul v5 audit / v3 rating, not a saved production revision.
 * Reads only frozen model references and checksum-verified public data snapshots. No database or network.
 */
export async function buildBaseline(games: CorpusGame[]): Promise<Record<string, ReconstructedBaseline>> {
  const root = process.cwd();
  const [historical, expectations, spread] = await Promise.all([
    loadGameProfileReference(path.join(root, 'analytics/models/game-profiles.json')),
    loadExpectationsReference(path.join(root, 'packages/core/reference/expectations-reference.json')),
    loadSpreadReference(path.join(root, 'analytics/models/spread-reference.json')),
  ]);
  const profileMap = new Map<string, GameProfile[]>();
  for (const profile of historical.reference.rows) profileMap.set(profile.gameId, [...(profileMap.get(profile.gameId) ?? []), profile]);
  const liveProfiles = new Map<number, { rows: ProviderRow[]; checksum: string } | null>();
  for (const season of [...new Set(games.filter(entry => !profileMap.has(entry.game.id)).map(entry => entry.game.season))]) {
    // false is intentional: baseline reconstruction never refreshes the network.
    // The shared loader verifies the current cache first, then falls back to a
    // stored snapshot only when no current cache exists.
    const source = season === 2026 ? await currentPublicSource(root, 'team-stats', false)
      : await storedSnapshot(root, `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`);
    liveProfiles.set(season, source ? { rows: parseCsv(await readFile(source.file)), checksum: source.source.checksum } : null);
  }
  const result: Record<string, ReconstructedBaseline> = {};
  for (const entry of games) {
    const game = entry.game;
    if (result[game.id]) throw new Error(`Duplicate baseline game: ${game.id}`);
    const notes = [
      'Reconstructed pre-overhaul rating from compact extension evidence and frozen statistical references; this is not a retrieved production revision.',
      'The compact extractor excludes ambiguous penalties, special-teams plays and clock plays more conservatively than the original raw-play extension check. Historical drive floors can therefore differ; missing evidence is not replaced with invented events.',
    ];
    let profiles: GameProfile[] = [], profileSource: ReconstructedBaseline['coverage']['profileSource'] = 'unavailable', profileSourceChecksum: string | null = null;
    const frozen = profileMap.get(game.id);
    if (frozen) {
      profiles = frozen.map(profile => gameAliases(profile, game));
      profileSource = 'frozen_game_profiles'; profileSourceChecksum = historical.checksum;
    } else {
      const current = liveProfiles.get(game.season);
      if (current) {
        try { profiles = normalizeGameProfiles(game, current.rows); profileSource = 'stored_team_stats'; profileSourceChecksum = current.checksum; }
        catch { notes.push('Paired team statistics are missing or inconsistent; aggregate profiles are unavailable, not zero.'); }
      } else notes.push('No checksum-verified team-stat snapshot is available; aggregate profiles are unavailable, not zero.');
    }
    const evidence = extensionEvidence(entry);
    const audit = buildGameAudit({ game, plays: evidence.plays, profiles, reference: historical.reference, referenceChecksum: historical.checksum });
    audit.version = 'under-review-game-audit-v5';
    audit.expectations = buildExpectations(game, audit.profiles, expectations);
    const checksum = entry.source.scheduleChecksum;
    // The corpus already verifies the schedule bytes. An empty retrieval time
    // truthfully records that the compact per-game entry does not retain it.
    const schedule: SourceSnapshot | null = /^[a-f0-9]{64}$/.test(checksum) ? {
      id: `corpus-schedule-${checksum}`, provider: 'nflverse-schedules', url: scheduleUrl,
      checksum, retrievedAt: '', path: '', license: 'CC-BY-4.0',
    } : null;
    audit.market = buildMarketAudit(game, schedule, spread);
    const verdict = getGameVerdict(audit), breakdown = getGameRatingBreakdown(audit);
    result[game.id] = {
      rating: verdict.rating, label: verdict.label, reason: verdict.summary,
      statFamilies: breakdown.families.filter(family => family.id !== 'drive'), driveCount: evidence.maxDrive,
      coverage: { profileSource, profileSourceChecksum, profiles: profiles.length, extensionPlays: evidence.plays.length,
        extensionPlaysWithDrive: evidence.withDrive, missingDriveExtensions: evidence.plays.length - evidence.withDrive,
        excludedPenalties: entry.observation.coverage.excludedPenalties, sourceOpportunities: entry.observation.opportunities.length }, notes,
    };
  }
  return result;
}
