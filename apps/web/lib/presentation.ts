export type RecordValue = Record<string, unknown>;
// Keep the previous NFL season selected through its playoffs and the offseason.
export function defaultNflSeason(now = new Date()): number { return now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0); }
export const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.map(record) : [];
export function first(value: RecordValue, ...keys: string[]): unknown {
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  return undefined;
}
export function str(value: unknown, fallback = ""): string { return typeof value === "string" || typeof value === "number" ? String(value) : fallback; }
export function num(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null; }
export function human(value: unknown, fallback = "Unavailable"): string { const text = str(value); return text ? text.replace(/[_-]/g, " ").replace(/^\w/, c => c.toUpperCase()) : fallback; }
export function dateTime(value: unknown): string {
  const source = str(value); if (!source) return "Not yet available";
  const date = new Date(source); return Number.isNaN(date.getTime()) ? "Not yet available" : new Intl.DateTimeFormat("en-US", {dateStyle: "medium", timeStyle: "short", timeZone: "UTC"}).format(date) + " UTC";
}
export function referencePeriod(start: number | null, end: number | null): string {
  if(start === null || end === null)return "Reference period unavailable";
  return start === end ? `${start} season` : `${start}–${end} seasons`;
}
export function auditLabel(status: string): string {
  return ({historical_outlier:"Highly unusual win",unusual_profile:"Unusual win",review_worthy:"Key plays flagged",no_flag_found:"No unusual result detected",insufficient_data:"Not enough data",rare_sample:"Small historical sample",context:"Historical context"} as Record<string,string>)[status] || human(status);
}
export function safeLink(value: unknown): string | undefined { try { const url = new URL(str(value)); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } }
export function statusTone(value: unknown): string { const text = str(value).toLowerCase(); return /failed|error|blocked|corrected/.test(text) ? "warning" : /reconciled|available|succeeded|completed|reviewed|approved/.test(text) && !/unavailable|not_reviewed|partially/.test(text) ? "positive" : "neutral"; }
export const teamNames: Record<string, string> = {ARI:"Arizona Cardinals",ATL:"Atlanta Falcons",BAL:"Baltimore Ravens",BUF:"Buffalo Bills",CAR:"Carolina Panthers",CHI:"Chicago Bears",CIN:"Cincinnati Bengals",CLE:"Cleveland Browns",DAL:"Dallas Cowboys",DEN:"Denver Broncos",DET:"Detroit Lions",GB:"Green Bay Packers",HOU:"Houston Texans",IND:"Indianapolis Colts",JAX:"Jacksonville Jaguars",KC:"Kansas City Chiefs",LAC:"Los Angeles Chargers",LA:"Los Angeles Rams",LAR:"Los Angeles Rams",LV:"Las Vegas Raiders",MIA:"Miami Dolphins",MIN:"Minnesota Vikings",NE:"New England Patriots",NO:"New Orleans Saints",NYG:"New York Giants",NYJ:"New York Jets",PHI:"Philadelphia Eagles",PIT:"Pittsburgh Steelers",SEA:"Seattle Seahawks",SF:"San Francisco 49ers",TB:"Tampa Bay Buccaneers",TEN:"Tennessee Titans",WAS:"Washington Commanders",OAK:"Oakland Raiders",SD:"San Diego Chargers",STL:"St. Louis Rams"};
export const teams = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LA", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"];
export const teamName = (team: string) => teamNames[team] || team;
export function dataMaturity(status: string) {
  if (status === "reconciled") return {label:"Updated source data", detail:"This report uses the provider’s cleaned postgame data. Later corrections can still update the report."};
  if (status === "corrected") return {label:"Updated after a correction", detail:"The source data changed after an earlier analysis. The report below includes that correction."};
  if (status === "preliminary") return {label:"Early source data", detail:"The automated analysis is complete using the first available final-game data. It will update when cleaned data arrives."};
  return {label:"Waiting for final data", detail:"Analysis starts automatically after the game ends and complete final-game data becomes available."};
}
export function gameView(raw: unknown) {
  const source = record(raw); const nested = record(source.game); const game = Object.keys(nested).length ? {...source, ...nested} : source;
  return {
    raw: game, id: str(first(game, "gameId", "game_id", "id")),
    home: str(first(game, "homeTeam", "home_team"), "Home"), away: str(first(game, "awayTeam", "away_team"), "Away"),
    homeScore: num(first(game, "homeScore", "home_score")), awayScore: num(first(game, "awayScore", "away_score")),
    season: str(game.season), week: str(game.week),
    statistical: str(first(game, "statisticalStatus", "statistical_status", "dataStatus", "data_status"), "awaiting_data"),
    charting: str(first(game, "chartingStatus", "charting_status"), "unavailable"),
    review: str(first(game, "reviewStatus", "review_status", "officiatingReviewStatus"), "not_reviewed"),
    finding: str(first(game, "strongestFinding", "strongest_finding", "summary", "verdict")),
    updated: first(game, "updatedAt", "updated_at", "analyzedAt", "analyzed_at"),
  };
}
export const categories = [
  {id: "officiating", title: "Impact of officiating decisions", note: "How a ruling changed the game state. Whether the ruling was correct is a separate question."},
  {id: "coaching", title: "Coaching decisions", note: "Fourth-down choices judged using what was known before the play."},
  {id: "fumble", title: "Fumble recoveries", note: "Who recovered loose balls compared with what the model expected."},
  {id: "kicking", title: "Kicking", note: "Field goals and extra points compared with the expected chance of making them."},
  {id: "execution", title: "Player execution", note: "Recorded drops, catch opportunities, and other player mistakes when detailed data is available."},
  {id: "penalty_anomaly", title: "Penalty patterns", note: "Whether the pattern of penalties looks unusual. The count alone cannot show that a call was wrong."},
];
export function metricCategory(metric: RecordValue): string {
  const category = str(first(metric, "category", "module", "metricKey", "key", "name")).toLowerCase();
  if (/review|error/.test(category) && !/execution/.test(category)) return "reviewed_errors";
  if (/coach|fourth|decision/.test(category)) return "coaching";
  if (/fumbl|recover/.test(category)) return "fumble";
  if (/kick|field_goal|extra_point/.test(category)) return "kicking";
  if (/execution|drop|catch|interception_worthy|cpoe|sack/.test(category)) return "execution";
  if (/anomal|penalty_rate|penalty_count|called_penalt/.test(category)) return "penalty";
  if (/officiat|ruling|penalty/.test(category)) return "officiating";
  return category;
}
