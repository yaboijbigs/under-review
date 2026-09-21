import { parse } from 'csv-parse/sync';
import type { Game } from './contracts.js';
import { SourceError } from './sources.js';

export type ProviderRow = Record<string, unknown>;
const STRING_FIELDS = /(?:^game_id$|^old_game_id$|_player_id$|^nflverse_game_id$|^clock$|^time$|^gametime$|^game_date$|^gameday$|^desc$|^description$|^start_time$|^date_pulled$|^gsis$|^espn$|^pfr$|^nfl_detail_id$)/;

export function parseCsv(bytes: Buffer | string): ProviderRow[] {
  const text = typeof bytes === 'string' ? bytes : bytes.toString('utf8');
  if (/^\s*</.test(text)) throw new SourceError('source_not_csv', 'Provider returned an HTML document instead of CSV.');
  try {
    const rows = parse(text, { columns: (headers: string[]) => {
      if (headers.some((header) => !header) || new Set(headers).size !== headers.length) throw new SourceError('source_csv_columns_invalid', 'CSV has empty or duplicate column names.');
      return headers;
    }, bom: true, skip_empty_lines: true, max_record_size: 1024 * 1024 }) as Record<string, string>[];
    return rows.map(normalizeRow);
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError('source_csv_invalid', 'Provider CSV could not be parsed.');
  }
}

/** Missing tags stay null; false/0 are observations, not missingness. */
export function normalizeRow(row: ProviderRow): ProviderRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return [key, null];
    if (typeof value !== 'string') return [key, value];
    if (value === '' || value === 'NA' || value === 'NaN' || value === 'null') return [key, null];
    if (STRING_FIELDS.test(key)) return [key, value];
    if (value === 'TRUE' || value === 'true') return [key, true];
    if (value === 'FALSE' || value === 'false') return [key, false];
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
      const number = Number(value);
      if (Number.isFinite(number)) return [key, number];
    }
    return [key, value];
  }));
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function assertGameId(id: string): void {
  if (!/^\d{4}_\d{2}_[A-Z]{2,3}_[A-Z]{2,3}$/.test(id)) throw new SourceError('invalid_game_id', 'Invalid nflverse game identifier.');
}

/** nflverse kickoff times are America/New_York local time, including international games. */
export function kickoffUtc(day: unknown, time: unknown): string | null {
  if (typeof day !== 'string' || typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const intended = Date.parse(`${day}T${time}:00Z`);
  if (!Number.isFinite(intended)) return null;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let candidate = intended;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(format.formatToParts(candidate).map((part) => [part.type, part.value]));
    const local = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
    const correction = intended - local;
    candidate += correction;
    if (correction === 0) return new Date(candidate).toISOString();
  }
  return null;
}

export function normalizeSchedule(row: ProviderRow): Game {
  const id = String(row.game_id ?? '');
  assertGameId(id);
  const season = numberOrNull(row.season);
  const week = numberOrNull(row.week);
  const homeTeam = String(row.home_team ?? '');
  const awayTeam = String(row.away_team ?? '');
  if (!season || !week || !Number.isInteger(season) || !Number.isInteger(week) || !homeTeam || !awayTeam || homeTeam === awayTeam || id !== `${season}_${String(week).padStart(2, '0')}_${awayTeam}_${homeTeam}`) {
    throw new SourceError('schedule_identity_invalid', 'Schedule row contains inconsistent game identity.');
  }
  return {
    id, season, week, gameType: String(row.game_type ?? ''), homeTeam, awayTeam,
    homeScore: numberOrNull(row.home_score), awayScore: numberOrNull(row.away_score),
    kickoffAt: kickoffUtc(row.gameday, row.gametime), providerData: row,
  };
}

export function normalizePlays(rows: ProviderRow[], gameId: string): ProviderRow[] {
  return rows.filter((row) => String(row.game_id) === gameId).map((row, index) => ({ ...normalizeRow(row), source_order: index }));
}

export interface GameValidation { valid: boolean; issues: string[] }

function scoringEvent(play: ProviderRow): { team: unknown; points: number } | null {
  // Tries have different point values, including the rare one-point safety.
  if (play.extra_point_attempt === 1 || play.two_point_attempt === 1) {
    if (play.safety === 1) return { team: play.defteam, points: 1 };
    if (play.defensive_extra_point_conv === 1 || play.defensive_two_point_conv === 1) return { team: play.defteam, points: 2 };
    if (play.extra_point_result === 'good') return { team: play.posteam, points: 1 };
    if (play.two_point_conv_result === 'success') return { team: play.posteam, points: 2 };
    return null;
  }
  if (play.touchdown === 1) return { team: play.td_team, points: 6 };
  if (play.field_goal_result === 'made') return { team: play.posteam, points: 3 };
  if (play.safety === 1) return { team: play.defteam, points: 2 };
  return null;
}

/** Conservative publishing gate. Terminal provider evidence is required independently of schedule scores. */
export function validateGameData(game: Game, plays: ProviderRow[]): GameValidation {
  const issues = new Set<string>();
  if (!plays.length) return { valid: false, issues: ['play_by_play_missing'] };
  if (game.homeScore === null || game.awayScore === null || numberOrNull(game.providerData.result) === null) issues.add('schedule_result_missing');
  const seen = new Set<string>();
  const quarters = new Set<number>();
  let reconstructedHome = 0;
  let reconstructedAway = 0;
  let previous: ProviderRow | undefined;
  for (const play of plays) {
    if (play.game_id !== game.id || play.home_team !== game.homeTeam || play.away_team !== game.awayTeam) issues.add('play_identity_mismatch');
    if (numberOrNull(play.season) !== game.season) issues.add('play_season_mismatch');
    const playId = numberOrNull(play.play_id);
    if (playId === null || playId < 0 || !Number.isInteger(playId)) issues.add('play_id_invalid');
    else if (seen.has(String(playId))) issues.add('play_id_duplicate');
    else seen.add(String(playId));
    const quarter = numberOrNull(play.qtr);
    if (quarter !== null) quarters.add(quarter);
    if (play.posteam !== null && play.posteam !== undefined && play.posteam !== game.homeTeam && play.posteam !== game.awayTeam) issues.add('possession_team_invalid');
    if (play.defteam !== null && play.defteam !== undefined && play.defteam !== game.homeTeam && play.defteam !== game.awayTeam) issues.add('defense_team_invalid');
    if (play.posteam && play.defteam && play.posteam === play.defteam) issues.add('possession_defense_conflict');
    const home = numberOrNull(play.total_home_score);
    const away = numberOrNull(play.total_away_score);
    if (home === null || away === null || home < 0 || away < 0) issues.add('running_score_missing_or_invalid');
    const scoring = scoringEvent(play);
    if (scoring?.team === game.homeTeam) reconstructedHome += scoring.points;
    else if (scoring?.team === game.awayTeam) reconstructedAway += scoring.points;
    else if (scoring) issues.add('scoring_team_unsupported');
    if (home !== reconstructedHome || away !== reconstructedAway) issues.add('scoring_sequence_incomplete_or_unsupported');
    // Replays and timeout rows can be reordered; IDs and clock values are not chronology alone.
    if (previous && play.posteam && previous.posteam && play.posteam !== previous.posteam) {
      const previousDrive = numberOrNull(previous.fixed_drive ?? previous.drive);
      const currentDrive = numberOrNull(play.fixed_drive ?? play.drive);
      const transition = previous.interception === 1 || previous.fumble_lost === 1 || previous.kickoff_attempt === 1 || previous.punt_attempt === 1 || previous.field_goal_attempt === 1 || previous.touchdown === 1 || previous.safety === 1 || previous.down === 4;
      if (previousDrive !== null && previousDrive === currentDrive && !transition && previous.qtr === play.qtr && previous.play_type !== 'no_play' && play.play_type !== 'no_play') issues.add('possession_sequence_ambiguous');
    }
    if (play.posteam && play.play_type && play.play_type !== 'no_play') previous = play;
  }
  if (![1, 2, 3, 4].every((quarter) => quarters.has(quarter))) issues.add('quarters_incomplete');
  if (String(plays[0]?.desc ?? '').trim() !== 'GAME') issues.add('game_start_marker_missing');
  const terminal = plays[plays.length - 1];
  if (String(terminal.desc ?? '').trim() !== 'END GAME' || terminal.drive_end_transition !== 'END_GAME') issues.add('explicit_game_end_missing');
  if ((numberOrNull(terminal.qtr) ?? 0) < 4) issues.add('terminal_quarter_invalid');
  if (numberOrNull(terminal.total_home_score) !== game.homeScore || numberOrNull(terminal.total_away_score) !== game.awayScore) issues.add('final_score_mismatch');
  if (game.homeScore !== null && game.awayScore !== null && numberOrNull(game.providerData.result) !== game.homeScore - game.awayScore) issues.add('schedule_score_mismatch');
  return { valid: issues.size === 0, issues: [...issues] };
}

export const FTN_FIELDS = ['is_interception_worthy', 'is_drop', 'is_catchable_ball', 'is_contested_ball', 'is_qb_fault_sack', 'is_created_reception'] as const;
export interface ChartingCoverage {
  status: 'unavailable' | 'partial' | 'available';
  joined: number;
  eligible: number;
  unmatched: number;
  conflicting: number;
  fields: Record<string, { eligible: number; observed: number; positive: number }>;
}

/** Duplicate/conflicting keys are quarantined; field-level opportunities determine coverage. */
export function joinCharting(gameId: string, plays: ProviderRow[], input: ProviderRow[]): { rows: ProviderRow[]; coverage: ChartingCoverage; issues: string[] } {
  const playById = new Map(plays.map((play) => [String(play.play_id), play]));
  const candidates = input.filter((row) => String(row.nflverse_game_id) === gameId).map(normalizeRow);
  const unique = new Map<string, ProviderRow>();
  const conflicts = new Set<string>();
  let unmatched = 0;
  for (const row of candidates) {
    const id = String(row.nflverse_play_id);
    if (!playById.has(id)) { unmatched++; continue; }
    const old = unique.get(id);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) conflicts.add(id);
    else unique.set(id, row);
  }
  for (const id of conflicts) unique.delete(id);
  const eligibleFor = (field: string, play: ProviderRow): boolean => field === 'is_qb_fault_sack' ? play.sack === 1 : play.pass_attempt === 1 && play.sack !== 1 && play.qb_spike !== 1 && play.play_type !== 'no_play';
  const fields: ChartingCoverage['fields'] = {};
  for (const field of FTN_FIELDS) {
    const eligible = plays.filter((play) => eligibleFor(field, play));
    const observed = eligible.map((play) => unique.get(String(play.play_id))?.[field]).filter((value) => value === true || value === false || value === 0 || value === 1);
    fields[field] = { eligible: eligible.length, observed: observed.length, positive: observed.filter((value) => value === true || value === 1).length };
  }
  const rows = [...unique.values()].map((row) => ({ ...row, ...Object.fromEntries(FTN_FIELDS.map((field) => [field, row[field] === true || row[field] === 1 ? true : row[field] === false || row[field] === 0 ? false : null])) }));
  const complete = Object.values(fields).every((field) => field.observed === field.eligible);
  const status = rows.length === 0 ? 'unavailable' : complete && unmatched === 0 && conflicts.size === 0 ? 'available' : 'partial';
  return {
    rows,
    coverage: { status, joined: rows.length, eligible: plays.filter((play) => eligibleFor('is_drop', play) || play.sack === 1).length, unmatched, conflicting: conflicts.size, fields },
    issues: [...(unmatched ? ['ftn_unmatched_plays'] : []), ...(conflicts.size ? ['ftn_conflicting_keys'] : [])],
  };
}
