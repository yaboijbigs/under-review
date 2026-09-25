import type {AnalysisResult,Game} from './contracts.js';
import type {ProviderRow} from './normalize.js';
import {buildOfficiatingAudit,type LoadedOfficiatingReference} from './officiating-reference.js';
import {OFFICIATING_REFERENCE_VERSION} from './officiating-contracts.js';
import {getGameVerdict} from './consumer-summary.js';
export const OFFICIATING_MODEL_ID='conditional-officiating';
/** Apply last: the other model outputs remain context, not rating inputs. */
export function applyOfficiatingAudit(game:Game,plays:ProviderRow[],analysis:AnalysisResult,loaded:LoadedOfficiatingReference):AnalysisResult{
 if(!analysis.gameAudit)return analysis;
 const result=structuredClone(analysis),audit=result.gameAudit!;
 audit.officiating=buildOfficiatingAudit(game,plays,loaded);
 audit.version='under-review-game-audit-v6';
 audit.headline=getGameVerdict(audit).summary;
 result.models=result.models.filter(m=>m.id!==OFFICIATING_MODEL_ID).map(m=>m.id==='game-profile-audit'?{...m,version:audit.version}:m);
 result.models.push({id:OFFICIATING_MODEL_ID,version:OFFICIATING_REFERENCE_VERSION,checksum:loaded.checksum,
  trainingWindow:'Prior five regular seasons; joint game/drive calibration from three earlier seasons, each predicted using its own earlier fit.',
  notes:'Conditional called-penalty expectations and supported regulation enforcement-state contrasts. Crew histories, spread, box score and observed momentum are context; no call-correctness or intent inference.'});
 return result;
}
