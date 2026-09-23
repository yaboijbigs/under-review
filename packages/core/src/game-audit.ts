import type { EvidenceEvent, Game, GameAudit, GameAuditFlag, GameProfile, GameProfileReference, ReviewCandidate } from './contracts.js';
import type { ProviderRow } from './normalize.js';

export const GAME_AUDIT_VERSION = 'under-review-game-audit-v4';

const finite = (value: unknown): number | null => value === null || value === undefined || value === '' || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value);
const yes = (value: unknown): boolean => value === true || value === 1;
const text = (value: unknown): string => value === null || value === undefined ? '' : String(value);
const fields = ['pointsFor', 'pointsAgainst', 'totalYards', 'opponentYards', 'penalties', 'penaltyYards', 'turnoverMargin'] as const;
const complete = (profile: GameProfile): boolean => fields.every(field => finite(profile[field]) !== null) && profile.team !== profile.opponent && profile.pointsFor! >= 0 && profile.pointsAgainst! >= 0 && profile.penalties! >= 0 && profile.penaltyYards! >= 0;

// A versioned library applied unchanged to every target: seven combinations of these
// three conditions. No fitted weights, target-specific thresholds or overall score.
const conditions = {
  low_offense: { label: 'Total offense below 200 yards', matches: (p: GameProfile) => p.totalYards! < 200 },
  heavy_penalties: { label: 'At least 100 penalty yards', matches: (p: GameProfile) => p.penaltyYards! >= 100 },
  negative_turnovers: { label: 'Negative turnover margin', matches: (p: GameProfile) => p.turnoverMargin! < 0 },
};
type Condition = keyof typeof conditions;
const patterns: { id: string; conditions: Condition[] }[] = [
  { id: 'low_offense_penalties_turnovers', conditions: ['low_offense', 'heavy_penalties', 'negative_turnovers'] },
  { id: 'low_offense_penalties', conditions: ['low_offense', 'heavy_penalties'] },
  { id: 'low_offense_turnovers', conditions: ['low_offense', 'negative_turnovers'] },
  { id: 'penalties_turnovers', conditions: ['heavy_penalties', 'negative_turnovers'] },
  { id: 'low_offense', conditions: ['low_offense'] },
  { id: 'heavy_penalties', conditions: ['heavy_penalties'] },
  { id: 'negative_turnovers', conditions: ['negative_turnovers'] },
];
export const GAME_AUDIT_PATTERN_LIBRARY = patterns.map(pattern => ({ id: pattern.id, conditions: pattern.conditions.map(key => conditions[key].label) }));

function priorRows(reference: GameProfileReference | null, game: Game): { rows: GameProfile[]; conflicts: number } {
  const unique = new Map<string, GameProfile>();
  const conflicts = new Set<string>();
  for (const row of reference?.rows ?? []) {
    if (!Number.isInteger(row.season) || row.season >= game.season || row.gameId === game.id || !complete(row)) continue;
    const key = `${row.gameId}:${row.team}`;
    const old = unique.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(row)) conflicts.add(key);
    else unique.set(key, row);
  }
  return { rows: [...unique.entries()].filter(([key]) => !conflicts.has(key)).map(([, row]) => row), conflicts: conflicts.size };
}

function currentProfiles(game: Game, supplied: GameProfile[], notes: string[]): GameProfile[] {
  return [game.homeTeam, game.awayTeam].map(team => {
    const home = team === game.homeTeam;
    const expected = { gameId: game.id, season: game.season, team, opponent: home ? game.awayTeam : game.homeTeam, pointsFor: home ? game.homeScore : game.awayScore, pointsAgainst: home ? game.awayScore : game.homeScore };
    const candidates = supplied.filter(profile => profile.gameId === game.id && profile.team === team);
    const profile = candidates[0];
    const conflict = candidates.some(candidate => JSON.stringify(candidate) !== JSON.stringify(profile));
    if (profile && !conflict && profile.season === game.season && profile.opponent === expected.opponent && profile.pointsFor === expected.pointsFor && profile.pointsAgainst === expected.pointsAgainst) return {
      ...expected, totalYards: profile.totalYards, opponentYards: profile.opponentYards, penalties: profile.penalties,
      penaltyYards: profile.penaltyYards, turnoverMargin: profile.turnoverMargin, nonOffensiveTouchdowns: profile.nonOffensiveTouchdowns,
    };
    if (profile) notes.push(`${team}: aggregate identity, score or duplicate-record conflict; profile statistics withheld.`);
    return { ...expected, totalYards: null, opponentYards: null, penalties: null, penaltyYards: null, turnoverMargin: null, nonOffensiveTouchdowns: null };
  });
}

function quarterSeconds(play: ProviderRow): number | null {
  const supplied = finite(play.quarter_seconds_remaining);
  if (supplied !== null) return supplied >= 0 && supplied <= 900 ? supplied : null;
  const clock = text(play.time).match(/^(\d{1,2}):([0-5]\d)$/);
  const seconds = clock ? Number(clock[1]) * 60 + Number(clock[2]) : finite(play.qtr) === 4 ? finite(play.game_seconds_remaining) : null;
  return seconds !== null && seconds >= 0 && seconds <= 900 ? seconds : null;
}

function observedWpMovement(play: ProviderRow, game: Game): number | null {
  const quarter = finite(play.qtr);
  if (quarter === null || quarter < 1 || quarter > 4) return null;
  const before = finite(play.home_wp); const after = finite(play.home_wp_post);
  if (before !== null && after !== null && before >= 0 && before <= 1 && after >= 0 && after <= 1) return Math.abs(after - before);
  const wpa = finite(play.wpa);
  if (wpa === null || Math.abs(wpa) > 1) return null;
  return play.posteam === game.homeTeam || play.posteam === game.awayTeam ? Math.abs(wpa) : null;
}

interface DriveExtension { playId:string;team:string;defense:string;down:number;drive:number|null;groupKey:string|null }
function driveExtensions(game:Game,plays:ProviderRow[]):{byPlay:Map<string,DriveExtension>;groups:DriveExtension[][]}{
  const unique=new Map<string,ProviderRow>();const conflicts=new Set<string>();
  for(const play of plays){
    const id=text(play.play_id);if(!id)continue;
    if(unique.has(id)&&JSON.stringify(unique.get(id))!==JSON.stringify(play))conflicts.add(id);
    else unique.set(id,play);
  }
  const byPlay=new Map<string,DriveExtension>();const groups=new Map<string,DriveExtension[]>();
  for(const [playId,play] of unique){
    const team=text(play.posteam);const defense=text(play.defteam);const down=finite(play.down);const description=text(play.desc);
    const penaltyType=text(play.penalty_type).trim();
    if(conflicts.has(playId)||(play.game_id!=null&&play.game_id!==game.id)||!yes(play.penalty)||!yes(play.first_down_penalty)||!([3,4] as (number|null)[]).includes(down)
      ||![game.homeTeam,game.awayTeam].includes(team)||defense!==(team===game.homeTeam?game.awayTeam:game.homeTeam)||text(play.penalty_team)!==defense
      ||!penaltyType||/\bunknown\b|\bunspecified\b|\bmultiple\b/i.test(penaltyType)||yes(play.first_down_pass)||yes(play.first_down_rush)
      ||/\bdeclined\b|\boffset(?:ting)?\b|\bno penalty\b|\bpicked up\b/i.test(description)||(description.match(/\bpenalty\b/gi)?.length??0)>1)continue;
    // Prefer the provider's corrected drive ID. Missing/invalid IDs still allow
    // the individual factual flag, but can never manufacture a drive cluster.
    const field=play.fixed_drive!=null?'fixed_drive':'drive';const value=finite(play[field]);
    const drive=value!==null&&Number.isInteger(value)&&value>0?value:null;
    const groupKey=drive===null?null:`${field}:${drive}:${team}`;
    const extension={playId,team,defense,down:down!,drive,groupKey};byPlay.set(playId,extension);
    if(groupKey)groups.set(groupKey,[...(groups.get(groupKey)??[]),extension]);
  }
  return {byPlay,groups:[...groups.values()].filter(group=>group.length>=2)};
}

function reviewCandidates(game: Game, plays: ProviderRow[], events: EvidenceEvent[],extensions:ReturnType<typeof driveExtensions>): ReviewCandidate[] {
  const candidates = new Map<string, ReviewCandidate>();
  const existing = new Map(events.map(event => [event.playId, event.id]));
  for (const play of plays) {
    const playId = text(play.play_id); if (!playId) continue;
    const description = text(play.desc); const quarter = finite(play.qtr); const seconds = quarterSeconds(play);
    const gap = finite(play.score_differential); const down = finite(play.down); const yardline = finite(play.yardline_100);
    const reversed = text(play.replay_or_challenge_result).trim().toLowerCase() === 'reversed' || /(?:ruling|play)\s+was\s+reversed/i.test(description);
    const reviewed = yes(play.replay_or_challenge) || /^(?:upheld|reversed)$/i.test(text(play.replay_or_challenge_result).trim()) || /\b(?:reviewed|upheld)\b/i.test(description);
    const catchOrScore = /\bpass\b|\bcatch\b|\bcompletion\b|\btouchdown\b|\bfield goal\b|\bscore\b/i.test(description);
    const scoring = /\bTOUCHDOWN\b|\bTWO[- ]POINT\b|\b2[- ]POINT\b/i.test(description) || yes(play.touchdown) || yes(play.two_point_attempt);
    const nullified = /\bno play\b|\bnullified\b|\bnegated\b|\bdisallowed\b/i.test(description) || play.play_type === 'no_play';
    const reasons: string[] = [];
    let priority: ReviewCandidate['priority'] = 'medium';
    const extension=extensions.byPlay.get(playId);
    if(extension){
      reasons.push(`Defensive penalty on ${extension.defense} awarded ${extension.team} a first down on ${extension.down===3?'third':'fourth'} down; call correctness requires review.`);
      const group=extensions.groups.find(group=>group[0].groupKey===extension.groupKey);
      if(group){reasons.push(`${group.length} defensive-penalty first downs on third or fourth down occurred on ${extension.team} drive ${extension.drive}; review the sequence together.`);priority='high';}
    }
    if (reversed && catchOrScore) {
      reasons.push('Replay reversed a catch or scoring ruling; review the correction and remaining effect separately.'); priority = 'high';
    }
    if (scoring && nullified) { reasons.push('A touchdown or two-point play was explicitly nullified.'); priority = 'high'; }
    const close = gap !== null && Math.abs(gap) <= 8;
    const late = quarter === 4 && seconds !== null && seconds <= 300;
    if (!reversed && reviewed && catchOrScore && close && quarter === 4 && seconds !== null && seconds <= 60) {
      reasons.push('Catch or scoring ruling reviewed in the final minute of a one-score game; an upheld ruling is not an error finding.'); priority = 'high';
    }
    if (close && (late || (quarter !== null && quarter > 4)) && (yes(play.penalty) || /\bPENALTY on\b/i.test(description))) reasons.push('Recorded penalty late in a one-score game; correctness and impact require review.');
    if (close && quarter === 4 && seconds !== null && seconds <= 120 && (down === 3 || down === 4) && yardline !== null && yardline > 0 && yardline <= 25 && (yes(play.incomplete_pass) || /\bpass incomplete\b/i.test(description))) {
      reasons.push('Late third- or fourth-down incompletion inside the opponent 25 in a one-score game.'); priority = 'high';
    }
    if (!reasons.length) continue;
    const old = candidates.get(playId);
    candidates.set(playId, {
      id: `${game.id}:${playId}:needs-review`, playId, quarter, clock: text(play.time) || null, description,
      team: [game.homeTeam, game.awayTeam].includes(text(play.posteam)) ? text(play.posteam) : null,
      reasons: [...new Set([...(old?.reasons ?? []), ...reasons])], priority: old?.priority === 'high' ? 'high' : priority,
      observedWpSwing: observedWpMovement(play, game), existingEventId: existing.get(playId) ?? null,
    });
  }
  return [...candidates.values()].sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || Math.abs(b.observedWpSwing ?? 0) - Math.abs(a.observedWpSwing ?? 0));
}

function observedContext(game: Game, plays: ProviderRow[], profiles: GameProfile[],extensions:ReturnType<typeof driveExtensions>): GameAudit['context'] {
  const context: GameAudit['context'] = extensions.groups.map(group=>({team:group[0].team,kind:'drive_extending_penalties',playIds:group.map(play=>play.playId),
    text:`${group[0].team} received ${group.length} first downs from ${group[0].defense} penalties on third or fourth down during drive ${group[0].drive}. Review these plays together; this does not establish that any call was wrong.`}));
  for (const profile of profiles) {
    const sacks = plays.filter(play => play.posteam === profile.team && yes(play.sack) && play.play_type !== 'no_play' && !yes(play.two_point_attempt));
    if (sacks.length) context.push({ team: profile.team, kind: 'sacks_allowed', text: `Allowed ${sacks.length} sacks, including ${sacks.filter(play => (finite(play.qtr) ?? 0) > 4).length} in overtime.`, playIds: sacks.map(play => text(play.play_id)) });
    const opponent = profiles.find(other => other.team === profile.opponent);
    if (opponent?.penalties !== null && opponent?.penalties !== undefined && opponent.penaltyYards !== null) context.push({ team: profile.team, kind: 'opponent_penalties', text: `Opponent ${profile.opponent} was charged ${opponent.penalties} penalties for ${opponent.penaltyYards} yards.`, playIds: plays.filter(play => play.penalty_team === profile.opponent && yes(play.penalty)).map(play => text(play.play_id)) });
    if (profile.nonOffensiveTouchdowns !== null && profile.nonOffensiveTouchdowns > 0) context.push({ team: profile.team, kind: 'non_offensive_touchdowns', text: `Recorded ${profile.nonOffensiveTouchdowns} defensive or special-teams touchdowns.`, playIds: plays.filter(play => play.td_team === profile.team && yes(play.touchdown) && (yes(play.return_touchdown) || play.posteam !== profile.team || ['punt', 'kickoff'].includes(text(play.play_type)))).map(play => text(play.play_id)) });
  }
  for (const play of plays) {
    const yards = finite(play.return_yards);
    if (!yes(play.punt_attempt) || play.play_type === 'no_play' || yards === null || yards < 40) continue;
    const team = [game.homeTeam, game.awayTeam].includes(text(play.return_team)) ? text(play.return_team) : [game.homeTeam, game.awayTeam].includes(text(play.defteam)) ? text(play.defteam) : null;
    context.push({ team, kind: 'long_punt_return', text: `${yards}-yard punt return.`, playIds: [text(play.play_id)] });
  }
  return context;
}

export function buildGameAudit({ game, plays = [], profiles: supplied = [], reference = null, referenceChecksum = null, events = [] }: {
  game: Game; plays?: ProviderRow[]; profiles?: GameProfile[]; reference?: GameProfileReference | null; referenceChecksum?: string | null; events?: EvidenceEvent[];
}): GameAudit {
  const notes = [
    'Descriptive after-game comparison of fixed conditions; this is not a pregame prediction, p-value, misconduct probability or proof of causation.',
    'These exploratory product rules were motivated by known cases, then versioned and applied uniformly. This is not independent or held-out validation; definitions are frozen for later evaluations.',
    'Seven overlapping patterns are checked. They are correlated and are not combined into an overall anomaly score; multiple-pattern searching can find apparent outliers.',
    'Reference counts use complete aggregate team-games from strictly earlier seasons, including regular season and postseason. Same-season and future records are excluded.',
    'At least 20 matching prior team-games are required for labels: at most 5% wins for Historical outlier; at most 10% for Unusual winning profile. These are product flag thresholds, not calibrated significance tests.',
    'Review candidates are neutral priorities, not adjudicated errors or complete officiating coverage. Observed WP movement is the absolute whole-play change, never a beneficiary attribution or error-attributable cost. Review priorities use regulation WP only; separate experimental overtime estimates do not determine call correctness or coaching costs.',
    'Defensive penalties awarding first downs on third or fourth down are checked throughout the game. At least two distinct qualifying plays sharing an explicit provider drive and offensive team form a drive review cluster; this is not a claim that every penalty erased a stop. Declined, offsetting, ambiguous and independently converted plays are excluded from this check.',
    'Official aggregate totals supply the profile. PBP evidence links for aggregate context may be partial, particularly for multiple penalties; no approximate PBP penalty totals enter rarity comparisons.',
  ];
  const profiles = currentProfiles(game, supplied, notes);
  const prior = priorRows(reference, game);
  if (prior.conflicts) notes.push(`${prior.conflicts} conflicting duplicate historical team-game records were excluded.`);
  if (!profiles.every(complete)) notes.push('Complete official aggregate profiles are unavailable for one or both teams; affected historical comparisons are withheld.');
  const years = prior.rows.map(row => row.season);
  const startSeason = years.length ? Math.min(...years) : null; const endSeason = years.length ? Math.max(...years) : null;
  const flags: GameAuditFlag[] = [];
  for (const profile of profiles) {
    if (!complete(profile) || profile.pointsFor! <= profile.pointsAgainst!) continue;
    for (const pattern of patterns) {
      if (!pattern.conditions.every(condition => conditions[condition].matches(profile))) continue;
      const matches = prior.rows.filter(row => pattern.conditions.every(condition => conditions[condition].matches(row)));
      const wins = matches.filter(row => row.pointsFor! > row.pointsAgainst!).length;
      const losses = matches.filter(row => row.pointsFor! < row.pointsAgainst!).length;
      const ties = matches.length - wins - losses;
      const winRate = matches.length >= 20 ? wins / matches.length : null;
      const status: GameAuditFlag['status'] = winRate === null ? 'rare_sample' : winRate <= .05 ? 'historical_outlier' : winRate <= .1 ? 'unusual_profile' : 'context';
      const title = status === 'historical_outlier' ? 'Historical outlier' : status === 'unusual_profile' ? 'Unusual winning profile' : status === 'rare_sample' ? 'Limited historical comparison' : 'Winning-profile context';
      flags.push({ id: `${game.id}:${profile.team}:${pattern.id}`, team: profile.team, title, conditions: pattern.conditions.map(condition => conditions[condition].label), status,
        detail: `${profile.team} won. Prior matching team-games: ${wins} wins, ${losses} losses, ${ties} ties among ${matches.length} matches from ${prior.rows.length} complete prior team-games.${winRate === null ? ' Fewer than 20 matches; no rarity label or historical win-rate claim.' : ' This frequency describes the comparison group, not the probability that this result was improper.'}`,
        reference: { startSeason, endSeason, teamGames: prior.rows.length, matchingGames: matches.length, wins, losses, ties, winRate } });
    }
  }
  const extensions=driveExtensions(game,plays);
  const candidates = reviewCandidates(game, plays, events,extensions);
  const strongest = flags.find(flag => flag.status === 'historical_outlier') ?? flags.find(flag => flag.status === 'unusual_profile');
  const status: GameAudit['status'] = strongest ? strongest.status as 'historical_outlier' | 'unusual_profile' : candidates.length ? 'review_worthy' : !profiles.every(complete) || !prior.rows.length || flags.some(flag => flag.status === 'rare_sample') ? 'insufficient_data' : 'no_flag_found';
  const headline = strongest ? `${strongest.team}: ${strongest.title.toLowerCase()} — win with ${strongest.conditions.map(condition => condition.toLowerCase()).join(' and ')}; ${strongest.reference.wins} wins in ${strongest.reference.matchingGames} matching prior team-games.${candidates.length ? ` ${candidates.length} plays need review.` : ''}` : candidates.length ? `${candidates.length} plays need review; no call-correctness judgment has been made.` : status === 'insufficient_data' ? 'Insufficient comparable data for a historical outlier label.' : 'No configured historical outlier flag found; officiating correctness remains unreviewed.';
  return { version: GAME_AUDIT_VERSION, status, headline, profiles, flags, reviewCandidates: candidates, context: observedContext(game, plays, profiles,extensions),
    reference: { version: reference?.version ?? 'unavailable', checksum: referenceChecksum, startSeason, endSeason, teamGames: prior.rows.length }, notes: [...notes, ...(reference?.notes ?? [])] };
}
