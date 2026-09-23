import { describe,expect,it } from 'vitest';
import type { AnalysisResult,Game,GameAudit,GameProfile,GameProfileReference,MarketAudit } from '../packages/core/src/contracts.js';
import { buildGameAudit } from '../packages/core/src/game-audit.js';
import { renderSocialPost,validateSocialPost,SOCIAL_TEMPLATE_VERSION } from '../packages/core/src/social-post.js';

const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:20,awayScore:23,kickoffAt:null,providerData:{}};
const winner:GameProfile={gameId:game.id,season:2026,team:'GB',opponent:'NYJ',pointsFor:23,pointsAgainst:20,totalYards:199,opponentYards:350,penalties:13,penaltyYards:133,turnoverMargin:-1,nonOffensiveTouchdowns:1};
const loser:GameProfile={...winner,team:'NYJ',opponent:'GB',pointsFor:20,pointsAgainst:23,totalYards:350,opponentYards:199,penalties:4,penaltyYards:30,turnoverMargin:1};
const reportUrl=`https://underreview.jbigs.com/games/${game.id}?revision=2`;
const footer=`\n\nSee the Review: ${reportUrl}\n\n#NFL #UnderReview`;
function audit(wins=1,n=20):GameAudit{
 const reference:GameProfileReference={schemaVersion:1,version:'test',startSeason:2025,endSeason:2025,sourceUrls:[],sourceChecksums:{},notes:[],rows:Array.from({length:n},(_,i)=>({...winner,gameId:`2025_${i}_GB_NYJ`,season:2025,pointsFor:i<wins?23:10}))};
 return buildGameAudit({game,profiles:[winner,loser],reference,referenceChecksum:'a'.repeat(64)});
}
const analysis=(gameAudit?:GameAudit)=>({gameAudit} as AnalysisResult);
function market(floor:2|3):MarketAudit{return {version:'under-review-spread-v1',status:'available',reasonCode:null,homeTeam:'NYJ',awayTeam:'GB',expectedHomeMargin:3,actualHomeMargin:-3,homeMarginError:-6,absoluteError:6,favoredTeam:'NYJ',pickem:false,atsWinner:'GB',atsResult:'away_covered',favoriteCovered:false,underdogWon:true,surprise:floor===3?'very_unusual':'unusual',ratingFloor:floor,source:{snapshotId:'synthetic-schedule',url:'https://example.invalid/synthetic',checksum:'a'.repeat(64),retrievedAt:'2026-09-23T00:00:00Z',field:'spread_line'},reference:{version:'synthetic',checksum:'b'.repeat(64),startSeason:2025,endSeason:2025,games:500,atLeastAsSurprising:floor===3?25:50,tailRate:floor===3?.05:.1,percentile:floor===3?95:90},notes:[]};}
function addCluster(a:GameAudit,n:number){
 a.context=a.context.filter(context=>context.kind==='drive_extending_penalties');const playIds=Array.from({length:n},(_,i)=>`19-${i}`);
 a.context.push({kind:'drive_extending_penalties',team:'GB',playIds,text:'Not used in posts'});
 a.reviewCandidates.push(...playIds.map(playId=>({id:playId,playId,quarter:4,clock:'06:49',description:'Raw visitor text must never enter an automated post',team:'GB',priority:'high' as const,observedWpSwing:null,existingEventId:null,reasons:['Defensive penalty on NYJ awarded GB a first down on third down; call correctness requires review.',`${n} defensive-penalty first downs on third or fourth down occurred on GB drive 19; review the sequence together.`]})));
}
describe('original automatic X final report prose',()=>{
 it.each([[1,'🔴 SUS — 4/5'],[2,'🟠 HMM — 3/5'],[3,'🟢 FAIR — 1/5']] as const)('preserves the requested multiline format for %i wins', (wins,label)=>{
  const draft=renderSocialPost(game,analysis(audit(wins)),reportUrl);expect(draft.valid).toBe(true);expect(draft.weightedLength).toBeLessThanOrEqual(280);
  expect(draft.text.startsWith(`${label}\nGB 23 — NYJ 20\n\n`)).toBe(true);expect(draft.text.endsWith(footer)).toBe(true);expect(draft.text).not.toContain('**');
  if(wins===1)expect(draft.text).toContain('\n\nOur system detected a strong fairness concern:\n⚠️ ');
  if(wins===2)expect(draft.text).toContain('\n\n📊 ');
  if(wins===3)expect(draft.text).toBe(`🟢 FAIR — 1/5\nGB 23 — NYJ 20\n\nNothing unusual surfaced in our automated checks. No qualifying statistical flags or key review candidates.${footer}`);
  if(wins<3){expect(draft.text).toContain(`${wins} ${wins===1?'win':'wins'} in 20`);expect(draft.evidenceIds.length).toBeGreaterThan(0);}
  expect(validateSocialPost(draft.text+' changed',draft)).toBe(false);
 });
 it('uses the exact top scale label as an editorial question with both kinds of evidence',()=>{
  const a=audit();addCluster(a,3);const draft=renderSocialPost(game,analysis(a),reportUrl);
  expect(draft.text.startsWith('🚨🚨 RIGGED? 🚨🚨\nGB 23 — NYJ 20\n\nA highly unusual statistical result AND a major penalty sequence favored the winner:\n⚠️ ')).toBe(true);expect(draft.text).toContain('1 win in 20');expect(draft.text).toContain('3 penalties extended one GB drive.');expect(draft.text.endsWith(footer)).toBe(true);
  expect(draft.text).not.toContain('Raw visitor');expect(draft.text).not.toContain('Screening,');expect(draft.valid).toBe(true);expect(validateSocialPost(draft.text,draft)).toBe(true);
 });
 it('keeps unsupported and sparse profiles unrated',()=>{
  for(const a of [undefined,audit(0,14)]){const draft=renderSocialPost(game,analysis(a),reportUrl);expect(draft.text.startsWith('⚪ UNRATED\n')).toBe(true);expect(draft.text).toContain('too limited');expect(draft.evidenceIds).toEqual([]);expect(draft.valid).toBe(true);}
 });
 it.each([2,3] as const)('explains a market-only level %i with the recorded line, actual result and attributable error',floor=>{
  const a=audit(3);a.market=market(floor);const draft=renderSocialPost(game,analysis(a),reportUrl);
  expect(draft.text.startsWith(`${floor===3?'🟠 HMM':'🟡 DEBATABLE'} — ${floor}/5\nGB 23 — NYJ 20\n\n📊 `)).toBe(true);expect(draft.text).toContain('Recorded line: NYJ -3; GB won by 3. 6 points off');expect(draft.text).toContain(`${floor===3?25:50}/500 prior games`);
  expect(draft.text).not.toContain('0 plays');expect(draft.text).not.toContain('too limited');expect(draft.evidenceIds).toEqual([`market:${game.id}:spread_line`]);expect(draft.valid).toBe(true);expect(draft.weightedLength).toBeLessThanOrEqual(280);
 });
 it('does not publish unvalidated market arithmetic or inflate the resulting rating',()=>{
  const a=audit(3);a.market=market(3);a.market.absoluteError=100;const draft=renderSocialPost(game,analysis(a),reportUrl);expect(draft.text).toContain('🟢 FAIR — 1/5');expect(draft.text).not.toContain('100 points');expect(draft.evidenceIds).toEqual([]);
 });
 it.each([1,2])('uses exact singular/plural review wording for %i plays',count=>{
  const a=audit(3);addCluster(a,1);if(count===2)a.reviewCandidates.push({...a.reviewCandidates[0],id:'other',playId:'other'});
  const draft=renderSocialPost(game,analysis(a),reportUrl);expect(draft.text).toBe(`🟡 DEBATABLE — 2/5\nGB 23 — NYJ 20\n\n👀 ${count} ${count===1?'play deserves':'plays deserve'} a closer look.${footer}`);expect(draft.text).not.toContain('Raw visitor');
 });
 it('leads with the stronger cluster when historical evidence only reaches a lower rating',()=>{
  const a=audit(2);addCluster(a,3);const draft=renderSocialPost(game,analysis(a),reportUrl);expect(draft.text).toContain('🔴 SUS — 4/5');expect(draft.text).toContain('3 defensive penalties extended one GB drive');
 });
 it('makes manually requested correction/update text explicit and pins its revision',()=>{
  for(const kind of ['correction','update'] as const){const draft=renderSocialPost(game,analysis(audit()),reportUrl,kind);expect(draft.text.toLowerCase().startsWith(kind+':')).toBe(true);expect(draft.text.endsWith(footer)).toBe(true);expect(draft.valid).toBe(true);}
 });
 it.each(['initial','correction','update'] as const)('keeps large realistic counts, both top-tier claims, emoji and complete footer within 280 for %s',kind=>{
  const a=audit(350,14000);addCluster(a,12);const draft=renderSocialPost(game,analysis(a),reportUrl,kind);
  expect(draft.valid).toBe(true);expect(draft.weightedLength).toBeLessThanOrEqual(280);expect(draft.text).toMatch(/350(?: wins in |\/)14000/);expect(draft.text).toContain('12');expect(draft.text).toContain('one GB drive');expect(draft.text).toContain('🚨🚨 RIGGED? 🚨🚨');expect(draft.text.endsWith(footer)).toBe(true);expect(draft.evidenceIds.length).toBe(13);
 });
 it.each(['correction','update'] as const)('budgets every level and market-only findings with the %s prefix and an unshortened long URL',kind=>{
  const review=audit(3);addCluster(review,1);const top=audit();addCluster(top,3);const marketOnly=audit(3);marketOnly.market=market(3);
  const longUrl=reportUrl+'&source='+ 'a'.repeat(300);
  for(const a of [audit(3),review,audit(2),audit(),top,marketOnly]){
   const draft=renderSocialPost(game,analysis(a),longUrl,kind);expect(draft.valid).toBe(true);expect(draft.weightedLength).toBeLessThanOrEqual(280);expect(draft.text).toContain(`${kind==='correction'?'Correction':'Update'}: `);expect(draft.text.endsWith(`See the Review: ${longUrl}\n\n#NFL #UnderReview`)).toBe(true);expect(validateSocialPost(draft.text,draft)).toBe(true);
  }
 });
 it('versions the changed templates',()=>expect(SOCIAL_TEMPLATE_VERSION).toBe('game-final-screening-v2'));
 it('does not validate an unscored game for publication',()=>expect(renderSocialPost({...game,homeScore:null},analysis(),reportUrl).valid).toBe(false));
});
