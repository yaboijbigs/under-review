import {beforeAll,describe,expect,it,vi} from 'vitest';
import type {Game,GameAudit,SourceSnapshot} from '../packages/core/src/contracts.js';
import {buildGameAudit} from '../packages/core/src/game-audit.js';
import {buildMarketAudit,loadSpreadReference} from '../packages/core/src/spread.js';
vi.mock('../packages/core/src/db.js',()=>({query:vi.fn(),transaction:vi.fn()}));
import {gameAuditCorrection} from '../packages/core/src/repository.js';
let audit:GameAudit;
beforeAll(async()=>{
 const game:Game={id:'2026_02_GB_NYJ',season:2026,week:2,gameType:'REG',homeTeam:'NYJ',awayTeam:'GB',homeScore:20,awayScore:23,kickoffAt:null,providerData:{result:-3,spread_line:-3.5}};
 const source:SourceSnapshot={id:'synthetic',provider:'nflverse-schedules',url:'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv',checksum:'a'.repeat(64),path:'',retrievedAt:'2026-09-21T00:00:00Z',license:'CC-BY-4.0'};
 audit=buildGameAudit({game});audit.market=buildMarketAudit(game,source,await loadSpreadReference());
});
describe('published market evidence corrections',()=>{
 it('treats first market coverage as an update and identical evidence as unchanged',()=>{
  const older=structuredClone(audit);delete older.market;
  expect(gameAuditCorrection(older,audit)).toBe(false);expect(gameAuditCorrection(audit,structuredClone(audit))).toBe(false);
 });
 it.each(['line','count','rate','withdrawal','removed'] as const)('identifies a changed prior market %s finding',(kind)=>{
  const changed=structuredClone(audit);
  if(kind==='line'){changed.market!.expectedHomeMargin=-2.5;changed.market!.atsResult='away_covered';}
  if(kind==='count')changed.market!.reference.games++;
  if(kind==='rate')changed.market!.reference.tailRate=.01;
  if(kind==='withdrawal')changed.market!.status='unavailable';
  if(kind==='removed')delete changed.market;
  expect(gameAuditCorrection(audit,changed)).toBe(true);
 });
 it('does not call a metadata-only revalidation a corrected result',()=>{
  const changed=structuredClone(audit);changed.market!.source!.checksum='b'.repeat(64);changed.market!.reference.checksum='c'.repeat(64);changed.market!.notes.push('Updated attribution.');
  expect(gameAuditCorrection(audit,changed)).toBe(false);
 });
});
