import {readFile,writeFile} from 'node:fs/promises';
import {currentPublicSource,readOfficiatingCorpus} from './lib/officiating-sources.js';
import {parseCsv,normalizePlays} from '../packages/core/src/normalize.js';
import {normalizeGameProfiles,loadGameProfileReference} from '../packages/core/src/game-profile-source.js';
import {buildGameAudit} from '../packages/core/src/game-audit.js';
import {applyExpectationsAudit} from '../packages/core/src/expectations-integration.js';
import {loadExpectationsReference} from '../packages/core/src/expectations.js';
import {applyOfficiatingAudit} from '../packages/core/src/officiating-integration.js';
import {loadOfficiatingReference} from '../packages/core/src/officiating-reference.js';
import {getGameVerdict} from '../packages/core/src/consumer-summary.js';
import {renderSocialPost} from '../packages/core/src/social-post.js';
import type {AnalysisResult} from '../packages/core/src/contracts.js';
// Explicitly offline; no repository/database/publisher imports or network refresh.
const root=process.cwd(),games=(await readOfficiatingCorpus(root,[2026])).slice(0,3);
const [pbp,stats,history,expectations,officiating]=await Promise.all([currentPublicSource(root,'pbp',false),currentPublicSource(root,'team-stats',false),loadGameProfileReference('analytics/models/game-profiles.json'),loadExpectationsReference(),loadOfficiatingReference()]);
if(!pbp||!stats)throw new Error('Verified public current-season snapshots are required.');
const rows=parseCsv(await readFile(pbp.file)),profiles=parseCsv(await readFile(stats.file)),previews=[];
for(const entry of games){const game=entry.game,plays=normalizePlays(rows,game.id);
 let analysis:AnalysisResult={schemaVersion:1,metrics:[],events:[],timeline:[],coverage:[],models:[],warnings:[],gameAudit:buildGameAudit({game,plays,profiles:normalizeGameProfiles(game,profiles),reference:history.reference,referenceChecksum:history.checksum})};
 analysis=applyOfficiatingAudit(game,plays,applyExpectationsAudit(game,analysis,expectations),officiating);
 const preview=renderSocialPost(game,analysis,'','initial','names');if(!preview.valid)throw new Error(`Invalid bounded preview: ${game.id}`);
 previews.push({gameId:game.id,rating:getGameVerdict(analysis.gameAudit).rating,text:preview.text,weightedLength:preview.weightedLength});
}
await writeFile('benchmarks/officiating/sample-previews.json',JSON.stringify({status:'experimental-previews-only-release-blocked',sourceChecksums:{pbp:pbp.source.checksum,teamStats:stats.source.checksum,reference:officiating.checksum},previews},null,2)+'\n');
console.log(JSON.stringify({saved:previews.length,published:0}));
