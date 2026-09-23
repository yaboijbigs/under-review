import { z } from 'zod';

const finite=z.number().finite(),nullable=finite.nullable(),count=z.number().int().nonnegative();
export const penaltyBaselineSchema=z.object({games:count,meanPenalties:nullable,meanPenaltyYards:nullable});
export const expectationTailSchema=z.object({status:z.enum(['supported','unavailable']),reasonCode:z.string().nullable(),anomalyScore:nullable,tailProbability:finite.min(0).max(1).nullable(),calibrationGames:count,atLeastAsUnusual:count});
export const gameExpectationsSchema=z.object({
 version:z.string(),gameId:z.string(),homeTeam:z.string(),awayTeam:z.string(),status:z.enum(['supported','limited','unavailable']),
 cutoff:z.object({targetSeason:z.number().int(),trainingSeasons:z.array(z.number().int()),calibrationSeasons:z.array(z.number().int())}),
 teams:z.array(z.object({team:z.string(),opponent:z.string(),actual:z.object({penalties:nullable,penaltyYards:nullable}),league:penaltyBaselineSchema,teamHistory:penaltyBaselineSchema,opponentDrawn:penaltyBaselineSchema,
  expected:z.object({penalties:finite,penaltyYards:finite}).nullable(),residual:z.object({penalties:finite,penaltyYards:finite}).nullable(),
  refereeHistory:penaltyBaselineSchema.extend({wins:count,losses:count,ties:count})})),
 referee:z.object({name:z.string().nullable(),canonicalId:z.string().nullable(),status:z.enum(['verified','schedule_only','conflict','missing']),reasonCode:z.string().nullable(),games:count,
  meanTotalPenalties:nullable,meanTotalPenaltyYards:nullable,home:penaltyBaselineSchema,away:penaltyBaselineSchema,effect:z.object({penalties:finite,penaltyYards:finite}).nullable()}),
 penalty:expectationTailSchema.extend({method:z.enum(['team_opponent_referee','team_opponent','unavailable']),components:z.array(z.object({id:z.enum(['total_count','total_yards','imbalance_count','imbalance_yards']),actual:finite,expected:finite,residual:finite,scale:finite.positive(),standardized:finite}))}),
 outcome:expectationTailSchema.extend({method:z.literal('retrospective_box_score'),actualHomeMargin:nullable,expectedHomeMargin:nullable,residual:nullable,coefficients:z.object({intercept:finite,yardsPer100:finite,turnoverMargin:finite}).nullable(),trainingGames:count}),
 reference:z.object({version:z.string(),checksum:z.string(),sourceUrls:z.array(z.string()),sourceChecksums:z.record(z.string(),z.string())}),notes:z.array(z.string())
});
export type GameExpectations=z.infer<typeof gameExpectationsSchema>;
export type ExpectationTail=z.infer<typeof expectationTailSchema>;
