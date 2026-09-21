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
export const analysisSchema=z.object({
  schemaVersion:z.literal(1),metrics:z.array(metricSchema),events:z.array(eventSchema),
  timeline:z.array(z.object({playId:z.string(),quarter:z.number().nullable(),clock:z.string().nullable(),homeWp:z.number().min(0).max(1).nullable(),description:z.string()})),
  coverage:z.array(z.object({category:z.string(),status:z.string(),eligible:z.number(),modeled:z.number(),reason:z.string().nullable().optional()})),
  models:z.array(z.object({id:z.string(),version:z.string(),trainingWindow:z.string().nullable().optional(),checksum:z.string().optional(),notes:z.string().optional()}).passthrough()),
  warnings:z.array(z.string())
});
export type AnalysisResult=z.infer<typeof analysisSchema>;
export interface AnalysisRequest {schemaVersion:1;action:'analyze';game:Game;plays:Record<string,unknown>[];ftn?:Record<string,unknown>[];snapshots:SourceSnapshot[];config:Record<string,unknown>}
export type StatisticalStatus='awaiting_data'|'preliminary'|'reconciled'|'corrected';
export interface Revision {id:string;number:number;createdAt:string;statisticalStatus:StatisticalStatus;chartingStatus:'unavailable'|'partial'|'available';reviewStatus:'not_reviewed'|'partially_reviewed'|'reviewed_within_scope';changeSummary:string;analysis:AnalysisResult;inputHash:string;sourceSnapshots:SourceSnapshot[];summary:string}
export interface GameCard extends Game {statisticalStatus:StatisticalStatus;chartingStatus:string;reviewStatus:string;finding:string|null;updatedAt:string|null;revisionNumber:number|null}
export interface Review {id:string;eventId:string;playId:string;reviewer:string;status:string;ruleSeason:number;ruleReference:string;evidenceUrl:string;rationale:string;confidence:string;scope:string;scopeComplete?:boolean;approved:boolean;stale:boolean;createdAt:string;replayCorrected:boolean}
export interface Draft {id:string;gameId:string;revisionId:string;text:string;status:string;kind:string;mode:string;createdAt:string;externalId:string|null;reason:string|null}
export interface GameReport {game:Game;revision:Revision;history:Pick<Revision,'id'|'number'|'createdAt'|'statisticalStatus'|'changeSummary'>[];reviews:Review[];drafts:Draft[]}
