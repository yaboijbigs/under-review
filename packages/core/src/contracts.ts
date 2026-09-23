import { z } from 'zod';

export const gameSchema = z.object({
  id:z.string(), season:z.number().int(), week:z.number().int(), gameType:z.string(),
  homeTeam:z.string(),awayTeam:z.string(),homeScore:z.number().nullable(),awayScore:z.number().nullable(),
  kickoffAt:z.string().nullable(),providerData:z.record(z.string(),z.unknown()).default({})
});
export type Game=z.infer<typeof gameSchema>;
export interface SourceSnapshot {id:string;provider:string;url:string;retrievedAt:string;checksum:string;providerVersion?:string;path:string;license:string;metadata?:Record<string,unknown>}
export const metricSchema=z.object({
  id:z.string(),category:z.enum(['officiating','coaching','fumble','kicking','execution','penalty_anomaly']),
  name:z.string(),team:z.string().nullable(),value:z.number().finite().nullable(),unit:z.string(),
  status:z.enum(['supported','unavailable','experimental']),reasonCode:z.string().nullable().optional(),
  eventIds:z.array(z.string()),playIds:z.array(z.string()),assumptions:z.array(z.string()),modelVersion:z.string(),
  coverage:z.object({eligible:z.number(),modeled:z.number()}),
  rarity:z.object({percentile:z.number().min(0).max(100).nullable(),status:z.enum(['supported','unavailable']),reasonCode:z.string().nullable().optional(),referencePeriod:z.string().nullable(),gameCount:z.number().int().min(0),modelVersion:z.string(),comparison:z.string(),referenceChecksum:z.string().nullable()}).optional(),
  actualState:z.record(z.string(),z.unknown()).nullable().optional(),alternativeState:z.record(z.string(),z.unknown()).nullable().optional()
});
export type Metric=z.infer<typeof metricSchema>;
export const eventSchema=z.object({id:z.string(),playId:z.string(),quarter:z.number().nullable(),clock:z.string().nullable(),description:z.string(),kind:z.string(),team:z.string().nullable(),reviewStatus:z.string().default('not_reviewed'),notes:z.array(z.string()).optional()});
export type EvidenceEvent=z.infer<typeof eventSchema>;
export const gameProfileSchema=z.object({
  gameId:z.string(),season:z.number().int(),team:z.string(),opponent:z.string(),
  pointsFor:z.number().nullable(),pointsAgainst:z.number().nullable(),totalYards:z.number().nullable(),opponentYards:z.number().nullable(),
  penalties:z.number().nullable(),penaltyYards:z.number().nullable(),turnoverMargin:z.number().nullable(),nonOffensiveTouchdowns:z.number().nullable()
});
export type GameProfile=z.infer<typeof gameProfileSchema>;
export interface GameProfileReference {schemaVersion:1;version:string;startSeason:number;endSeason:number;sourceUrls:string[];sourceChecksums:Record<string,string>;rows:GameProfile[];notes:string[]}
const profileComparisonSchema=z.object({startSeason:z.number().nullable(),endSeason:z.number().nullable(),teamGames:z.number().int(),matchingGames:z.number().int(),wins:z.number().int(),losses:z.number().int(),ties:z.number().int(),winRate:z.number().nullable()});
export const gameAuditFlagSchema=z.object({id:z.string(),team:z.string(),title:z.string(),conditions:z.array(z.string()),status:z.enum(['historical_outlier','unusual_profile','rare_sample','context']),detail:z.string(),reference:profileComparisonSchema});
export type GameAuditFlag=z.infer<typeof gameAuditFlagSchema>;
export const reviewCandidateSchema=z.object({id:z.string(),playId:z.string(),quarter:z.number().nullable(),clock:z.string().nullable(),description:z.string(),team:z.string().nullable(),reasons:z.array(z.string()),priority:z.enum(['high','medium']),observedWpSwing:z.number().nullable(),existingEventId:z.string().nullable()});
export type ReviewCandidate=z.infer<typeof reviewCandidateSchema>;
export const marketAuditSchema=z.object({
 version:z.string(),status:z.enum(['available','unavailable']),reasonCode:z.string().nullable(),
 homeTeam:z.string(),awayTeam:z.string(),expectedHomeMargin:z.number().nullable(),actualHomeMargin:z.number().nullable(),homeMarginError:z.number().nullable(),absoluteError:z.number().nullable(),
 favoredTeam:z.string().nullable(),pickem:z.boolean().nullable(),atsWinner:z.string().nullable(),atsResult:z.enum(['home_covered','away_covered','push']).nullable(),favoriteCovered:z.boolean().nullable(),underdogWon:z.boolean().nullable(),
 surprise:z.enum(['ordinary','unusual','very_unusual','unavailable']),ratingFloor:z.union([z.literal(1),z.literal(2),z.literal(3)]).nullable(),
 source:z.object({snapshotId:z.string(),url:z.string(),checksum:z.string(),retrievedAt:z.string(),field:z.literal('spread_line')}).nullable(),
 reference:z.object({version:z.string(),checksum:z.string().nullable(),startSeason:z.number().int().nullable(),endSeason:z.number().int().nullable(),games:z.number().int().nonnegative(),atLeastAsSurprising:z.number().int().nonnegative(),tailRate:z.number().min(0).max(1).nullable(),percentile:z.number().min(0).max(100).nullable()}),
 notes:z.array(z.string())
});
export type MarketAudit=z.infer<typeof marketAuditSchema>;
export const gameAuditSchema=z.object({
  version:z.string(),status:z.enum(['historical_outlier','unusual_profile','review_worthy','no_flag_found','insufficient_data']),headline:z.string(),
  profiles:z.array(gameProfileSchema),flags:z.array(gameAuditFlagSchema),reviewCandidates:z.array(reviewCandidateSchema),
  context:z.array(z.object({team:z.string().nullable(),text:z.string(),playIds:z.array(z.string()),kind:z.string()})),
  reference:z.object({version:z.string(),checksum:z.string().nullable(),startSeason:z.number().nullable(),endSeason:z.number().nullable(),teamGames:z.number().int()}),
  notes:z.array(z.string()),market:marketAuditSchema.optional()
});
export type GameAudit=z.infer<typeof gameAuditSchema>;
export const analysisSchema=z.object({
  schemaVersion:z.literal(1),metrics:z.array(metricSchema),events:z.array(eventSchema),
  timeline:z.array(z.object({playId:z.string(),quarter:z.number().nullable(),clock:z.string().nullable(),homeWp:z.number().min(0).max(1).nullable(),description:z.string(),
    awayWp:z.number().min(0).max(1).nullable().optional(),tieProbability:z.number().min(0).max(1).nullable().optional(),
    status:z.enum(['experimental','unavailable','observed']).optional(),reasonCode:z.string().nullable().optional(),
    modelVersion:z.string().optional(),supportGames:z.number().int().min(0).optional(),phase:z.string().optional()})),
  coverage:z.array(z.object({category:z.string(),status:z.string(),eligible:z.number(),modeled:z.number(),reason:z.string().nullable().optional()})),
  models:z.array(z.object({id:z.string(),version:z.string(),trainingWindow:z.string().nullable().optional(),checksum:z.string().optional(),notes:z.string().optional()}).passthrough()),
  warnings:z.array(z.string()),gameAudit:gameAuditSchema.optional()
});
export type AnalysisResult=z.infer<typeof analysisSchema>;
export interface AnalysisRequest {schemaVersion:1;action:'analyze';game:Game;plays:Record<string,unknown>[];ftn?:Record<string,unknown>[];snapshots:SourceSnapshot[];config:Record<string,unknown>}
export type StatisticalStatus='awaiting_data'|'preliminary'|'reconciled'|'corrected';
export interface Revision {id:string;number:number;createdAt:string;statisticalStatus:StatisticalStatus;chartingStatus:'unavailable'|'partial'|'available';reviewStatus:'not_reviewed'|'partially_reviewed'|'reviewed_within_scope';changeSummary:string;analysis:AnalysisResult;inputHash:string;sourceSnapshots:SourceSnapshot[];summary:string}
export interface GameCard extends Game {statisticalStatus:StatisticalStatus;chartingStatus:string;reviewStatus:string;finding:string|null;updatedAt:string|null;revisionNumber:number|null;gameAudit?:GameAudit|null}
export interface Review {id:string;eventId:string;playId:string;reviewer:string;status:string;ruleSeason:number;ruleReference:string;evidenceUrl:string;rationale:string;confidence:string;scope:string;scopeComplete?:boolean;approved:boolean;stale:boolean;createdAt:string;replayCorrected:boolean}
export interface Draft {id:string;gameId:string;revisionId:string;text:string;status:string;kind:string;mode:string;createdAt:string;externalId:string|null;reason:string|null}
export interface GameReport {game:Game;revision:Revision;history:Pick<Revision,'id'|'number'|'createdAt'|'statisticalStatus'|'changeSummary'>[];reviews:Review[];drafts:Draft[]}
