export type RecordValue = Record<string, unknown>;
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
export function safeLink(value: unknown): string | undefined { try { const url = new URL(str(value)); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } }
export function statusTone(value: unknown): string { const text = str(value).toLowerCase(); return /failed|error|blocked|corrected/.test(text) ? "warning" : /reconciled|available|succeeded|completed|reviewed|approved/.test(text) && !/unavailable|not_reviewed|partially/.test(text) ? "positive" : "neutral"; }
export const teams = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS"];
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
  {id: "officiating", title: "Ruling impact", note: "The consequence of an observed ruling, separately from whether it was correct."},
  {id: "reviewed_errors", title: "Reviewed errors", note: "Evidence-backed human judgments within an explicitly stated review scope."},
  {id: "coaching", title: "Coaching decisions", note: "Fourth-down choices evaluated using information available before the outcome."},
  {id: "fumble", title: "Fumble recovery", note: "Recovery results relative to a contextual baseline; fumble creation is separate."},
  {id: "kicking", title: "Kicking", note: "Field goals and extra points relative to an expected-make baseline."},
  {id: "execution", title: "Execution charting", note: "Charted opportunities and mistakes, with missing coverage made explicit."},
  {id: "penalty_anomaly", title: "Called-penalty patterns", note: "Unusual calling rates do not establish whether a foul occurred or a call was wrong."},
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
