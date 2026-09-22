import {describe,expect,it} from 'vitest';
import {catchupKind,validateCoverageScope,type CoverageGame} from '../packages/core/src/season-coverage.js';
import {GAME_AUDIT_VERSION} from '../packages/core/src/game-audit.js';
const now=Date.parse('2026-09-22T01:00:00Z');
const game:CoverageGame={id:'2026_01_NE_SEA',week:1,kickoffAt:'2026-09-10T00:20:00Z',homeScore:13,awayScore:10,revisionId:null,revision:null,statisticalStatus:null,auditVersion:null,auditStatus:null,jobs:[]};
describe('explicit bounded regular-season catch-up',()=>{
 it('includes a missing Week 1 report older than the normal eight-day scheduler window',()=>expect(catchupKind(game,now)).toBe('analyze'));
 it('refreshes existing R results instead of needlessly repeating R',()=>expect(catchupKind({...game,revisionId:'existing'},now)).toBe('refresh-audit'));
 it('does not queue tonight before the schedule has a result',()=>expect(catchupKind({...game,kickoffAt:'2026-09-22T00:15:00Z',homeScore:null,awayScore:null},now)).toBeNull());
 it('rejects future or invalid kickoff data, even with stray scores',()=>{expect(catchupKind({...game,kickoffAt:'2026-09-23T00:15:00Z'},now)).toBeNull();expect(catchupKind({...game,kickoffAt:'invalid'},now)).toBeNull();});
 it('retains completed zero-score games',()=>expect(catchupKind({...game,homeScore:0},now)).toBe('analyze'));
 it('leaves current audits and in-flight analyses alone',()=>{expect(catchupKind({...game,auditVersion:GAME_AUDIT_VERSION},now)).toBeNull();expect(catchupKind({...game,jobs:[{kind:'analyze',status:'running',attempts:1,error:null}]},now)).toBeNull();});
 it('coalesces already queued catch-up work while preserving visible failed work for retry',()=>{expect(catchupKind({...game,jobs:[{kind:'analyze',status:'pending',attempts:0,error:null,key:'catchup:test'}]},now)).toBeNull();expect(catchupKind({...game,jobs:[{kind:'analyze',status:'failed',attempts:5,error:'Source unavailable',key:'catchup:test'}]},now)).toBe('analyze');});
 it('requires explicit regular-season weeks and bounds each run to two',()=>{expect(validateCoverageScope(2026,[2,1,1])).toEqual([1,2]);for(const weeks of [[],[0],[19],[1,2,3],[NaN]])expect(()=>validateCoverageScope(2026,weeks)).toThrow();});
});
