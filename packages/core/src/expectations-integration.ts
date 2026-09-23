import type { AnalysisResult,Game } from './contracts.js';
import { buildExpectations,EXPECTATIONS_VERSION,type LoadedExpectationsReference } from './expectations.js';
import { GAME_AUDIT_VERSION } from './game-audit.js';
import { getGameVerdict } from './consumer-summary.js';

export const EXPECTATIONS_MODEL_ID='game-expectations';
export function applyExpectationsAudit(game:Game,analysis:AnalysisResult,loaded:LoadedExpectationsReference):AnalysisResult{
 if(!analysis.gameAudit)return analysis;
 const result=structuredClone(analysis);
 result.gameAudit!.expectations=buildExpectations(game,result.gameAudit!.profiles,loaded);
 result.gameAudit!.version=GAME_AUDIT_VERSION;
 result.gameAudit!.headline=getGameVerdict(result.gameAudit).summary;
 result.models=result.models.filter(model=>model.id!==EXPECTATIONS_MODEL_ID).map(model=>model.id==='game-profile-audit'?{...model,version:GAME_AUDIT_VERSION}:model);
 result.models.push({id:EXPECTATIONS_MODEL_ID,version:EXPECTATIONS_VERSION,checksum:loaded.checksum,
  trainingWindow:'Five completed seasons before the game; calibration uses three earlier seasons, each predicted from its own prior five seasons.',
  notes:'Team/opponent/referee penalty expectations and retrospective yardage/turnover outcome expectation. Separate family tails; referee/team win records are context only.'});
 return result;
}
