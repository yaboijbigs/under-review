import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it,vi } from 'vitest';
import { config } from '../packages/core/src/config.js';
import type { AnalysisResult, Game, SourceSnapshot } from '../packages/core/src/contracts.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const namespace = `ur_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Client;
let db: typeof import('../packages/core/src/db.js');
let repository: typeof import('../packages/core/src/repository.js');
let jobs: typeof import('../packages/core/src/jobs.js');
let publishing: typeof import('../packages/core/src/publishing.js');
let reviews: typeof import('../packages/core/src/reviews.js');
const originalDatabaseUrl = config.databaseUrl;

const game: Game = {
  id: '2099_01_TST_DEMO', season: 2099, week: 1, gameType: 'REG', homeTeam: 'DEMO', awayTeam: 'TST',
  homeScore: 17, awayScore: 10, kickoffAt: '2099-09-10T17:00:00.000Z',
  providerData: { synthetic: true, result: 7 },
};
const snapshot: SourceSnapshot = {
  id: 'synthetic-database-fixture-v1', provider: 'synthetic-pbp', url: 'https://example.invalid/synthetic-pbp',
  retrievedAt: '2099-09-10T21:00:00.000Z', checksum: 'a'.repeat(64), path: '/synthetic/test-only',
  license: 'Synthetic test data', metadata: { synthetic: true },
};
function result(value = 0.02): AnalysisResult {
  return {
    schemaVersion: 1,
    metrics: [{ id: 'synthetic-decision', category: 'coaching', name: 'Synthetic decision cost', team: 'TST', value, unit: 'wp_delta', status: 'supported', eventIds: [`${game.id}:50`], playIds: ['50'], assumptions: ['Explicitly synthetic database test.'], modelVersion: 'synthetic-v1', coverage: { eligible: 1, modeled: 1 } }],
    events: [{ id: `${game.id}:50`, playId: '50', quarter: 4, clock: '02:00', description: 'Synthetic test decision.', kind: 'coaching', team: 'TST', reviewStatus: 'not_reviewed' }],
    timeline: [], coverage: [{ category: 'execution', status: 'unavailable', eligible: 0, modeled: 0, reason: 'Synthetic test has no charting.' }],
    models: [], warnings: ['Explicitly synthetic fixture; never publish.'],
  };
}

describe.skipIf(!enabled)('PostgreSQL durable revisions and jobs (isolated temporary schema)', () => {
  beforeAll(async () => {
    if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Invalid generated test schema.');
    admin = new pg.Client({ connectionString: originalDatabaseUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const connection = new URL(originalDatabaseUrl);
    connection.searchParams.set('options', `-c search_path=${namespace}`);
    config.databaseUrl = connection.toString();
    db = await import('../packages/core/src/db.js');
    await db.migrate();
    repository = await import('../packages/core/src/repository.js');
    jobs = await import('../packages/core/src/jobs.js');
    publishing = await import('../packages/core/src/publishing.js');
    reviews = await import('../packages/core/src/reviews.js');
  }, 60_000);

  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      // This namespace is generated above and never includes production tables or fixture records.
      if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Refusing unsafe test cleanup.');
      await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
    config.databaseUrl = originalDatabaseUrl;
  }, 30_000);

  it('reprocesses identical evidence without duplicate revisions or dry-run drafts', async () => {
    const first = await repository.saveAnalysis(game, [{ play_id: 50 }], [snapshot], result(), 'clean');
    const repeated = await repository.saveAnalysis(game, [{ play_id: 50 }], [snapshot], result(), 'clean');
    expect(first.created).toBe(true);
    expect(repeated).toEqual({ id: first.id, number: 1, created: false });
    const one = await publishing.createDraft(game.id);
    const two = await publishing.createDraft(game.id);
    expect(two.id).toBe(one.id);
    expect((await db.query('SELECT count(*)::integer AS n FROM publication_outbox')).rows[0].n).toBe(1);
    expect((await db.query('SELECT mode,status FROM publication_outbox')).rows[0]).toEqual({ mode: 'dry_run', status: 'draft' });
  });

  it('preserves the old score and findings when a correction creates a new revision', async () => {
    const corrected: Game = { ...game, homeScore: 20, providerData: { synthetic: true, result: 10 } };
    const changed = await repository.saveAnalysis(corrected, [{ play_id: 50 }], [{ ...snapshot, id: 'synthetic-database-fixture-v2', checksum: 'b'.repeat(64) }], result(0.03), 'clean');
    expect(changed.number).toBe(2);
    const previous = await repository.getReport(game.id, 1);
    const latest = await repository.getReport(game.id);
    expect(previous?.game.homeScore).toBe(17);
    expect(previous?.revision.analysis.metrics[0].value).toBe(0.02);
    expect(latest?.game.homeScore).toBe(20);
    expect(latest?.revision.analysis.metrics[0].value).toBe(0.03);
    expect(latest?.revision.statisticalStatus).toBe('corrected');
    expect(latest?.history).toHaveLength(2);
  });

  it('allows only one of two workers to claim jobs for the same game', async () => {
    await jobs.enqueue('synthetic-test', game.id, {}, 'synthetic:first');
    await jobs.enqueue('synthetic-test', game.id, {}, 'synthetic:second');
    const claims = await Promise.all([jobs.claimJob('synthetic-worker-one'), jobs.claimJob('synthetic-worker-two')]);
    const claimed = claims.filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect((await db.query("SELECT count(*)::integer AS n FROM jobs WHERE status='running'")).rows[0].n).toBe(1);
    await jobs.finishJob(claimed[0]!);
    const next = await jobs.claimJob('synthetic-worker-three');
    expect(next).not.toBeNull();
    expect(next?.id).not.toBe(claimed[0]?.id);
    await jobs.finishJob(next!);
  });

  it('recovers an expired job lease without permitting the stale worker to finish the new claim', async () => {
    const id = await jobs.enqueue('synthetic-test', game.id, {}, 'synthetic:lease');
    const abandoned = await jobs.claimJob('synthetic-abandoned');
    expect(abandoned?.id).toBe(id);
    await db.query("UPDATE jobs SET lease_until=now()-interval '1 minute' WHERE id=$1", [id]);
    const recovered = await jobs.claimJob('synthetic-recovery');
    expect(recovered?.id).toBe(id);
    expect(recovered?.attempts).toBe(2);
    await jobs.finishJob(abandoned!);
    expect((await db.query('SELECT status,worker_id FROM jobs WHERE id=$1', [id])).rows[0]).toEqual({ status: 'running', worker_id: 'synthetic-recovery' });
    await jobs.finishJob(recovered!);
  });

  it('keeps live submission disabled by default, without contacting X', async () => {
    expect(await publishing.getPublishingSettings()).toEqual({ mode: 'draft-only', killSwitch: true, accountId: null, activatedAt: null });
    await expect(publishing.publishOutbox(randomUUID())).rejects.toThrow('Live publishing blocked');
    expect((await db.query('SELECT count(*)::integer AS n FROM publication_attempts')).rows[0].n).toBe(0);
  });

  it('preserves scoped reviews on unchanged evidence across a new source snapshot', async () => {
    const reviewerId = randomUUID();
    await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'synthetic-reviewer','unused-test-password-hash','admin')", [reviewerId]);
    const session = { id: 'synthetic-session', userId: reviewerId, username: 'synthetic-reviewer', role: 'admin' as const, csrfToken: 'synthetic-csrf', expiresAt: '2099-12-31T00:00:00.000Z' };
    const reviewId = await reviews.saveReview({
      gameId: game.id, eventId: `${game.id}:50`, status: 'supported', ruleSeason: 2099,
      ruleReference: 'Synthetic rule reference', evidenceUrl: 'https://example.invalid/synthetic-evidence',
      rationale: 'Explicitly synthetic review to test revision preservation.', confidence: 'medium',
      scope: 'One synthetic test play; not a comprehensive review.', scopeComplete: true, replayCorrected: false,
    }, session);
    const pending = await repository.getReport(game.id);
    expect(pending?.revision.reviewStatus).toBe('partially_reviewed');
    expect(pending?.reviews.find((review) => review.id === reviewId)?.scopeComplete).toBe(true);
    await reviews.approveReview(reviewId, session);
    const before = await repository.getReport(game.id);
    expect(before?.reviews.find((review) => review.id === reviewId)?.stale).toBe(false);
    expect(before?.revision.reviewStatus).toBe('reviewed_within_scope');
    expect(before?.revision.summary).toContain('One synthetic test play; not a comprehensive review.');
    expect((await repository.getReport(game.id, pending!.revision.number))?.revision.reviewStatus).toBe('partially_reviewed');
    expect((await repository.getAdminOverview()).games.some((entry) => entry.id === game.id)).toBe(true);
    await repository.saveAnalysis({ ...game, homeScore: 20, providerData: { synthetic: true, result: 10 } }, [{ play_id: 50 }], [{ ...snapshot, id: 'synthetic-database-fixture-v3', checksum: 'c'.repeat(64) }], result(0.03), 'clean');
    const after = await repository.getReport(game.id);
    expect(after?.reviews.find((review) => review.id === reviewId)?.stale).toBe(false);
    expect(after?.revision.reviewStatus).toBe('reviewed_within_scope');
    expect(after?.revision.analysis.events.find((event) => event.playId === '50')?.reviewStatus).toBe('supported');
  });

  it('deduplicates manual descriptions and retains their underlying event after reconciliation', async () => {
    const reviewer = (await db.query("SELECT id FROM users WHERE username='synthetic-reviewer'")).rows[0];
    const session = { id: 'synthetic-session', userId: reviewer.id, username: 'synthetic-reviewer', role: 'admin' as const, csrfToken: 'synthetic-csrf', expiresAt: '2099-12-31T00:00:00.000Z' };
    const corrected = { ...game, homeScore: 20, providerData: { synthetic: true, result: 10 } };
    const plays = [{ play_id: 50 }, { play_id: 99, qtr: 4, time: '01:00', desc: 'Explicitly synthetic unflagged test play.' }];
    await repository.saveAnalysis(corrected, plays, [{ ...snapshot, id: 'synthetic-database-fixture-v4', checksum: 'd'.repeat(64) }], result(0.03), 'clean');
    const one = await reviews.insertMissedEvent({ gameId: game.id, playId: '99', description: 'First synthetic missed-call description.', team: 'TST' }, session);
    const two = await reviews.insertMissedEvent({ gameId: game.id, playId: '99', description: 'Second description of the same synthetic play.', team: 'TST' }, session);
    expect(two).toBe(one);
    expect((await db.query('SELECT count(*)::integer AS n FROM events WHERE game_id=$1 AND play_id=$2', [game.id, '99'])).rows[0].n).toBe(1);
    await repository.saveAnalysis(corrected, plays, [{ ...snapshot, id: 'synthetic-database-fixture-v5', checksum: 'e'.repeat(64) }], result(0.03), 'clean');
    const after = await repository.getReport(game.id);
    const retained = after?.revision.analysis.events.find((event) => event.id === one);
    expect(retained?.playId).toBe('99');
    expect(retained?.notes).toHaveLength(2);
  });

  it('checks the expected base under the revision lock before changing games or registering sources', async () => {
    const guardedGame = { ...game, id: '2099_02_TST_DEMO', week: 2 };
    const first = await repository.saveAnalysis(guardedGame, [], [snapshot], { ...result(), events: [] }, 'clean');
    const corrected = { ...guardedGame, homeScore: 24 };
    const latest = await repository.saveAnalysis(corrected, [], [snapshot], { ...result(0.06), events: [] }, 'clean');
    const rejectedSource = { ...snapshot, id: 'synthetic-rejected-stale-source', checksum: 'f'.repeat(64) };
    await expect(repository.saveAnalysis(guardedGame, [], [rejectedSource], { ...result(), events: [] }, 'clean', { expectedBaseRevisionId: first.id })).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await repository.getGame(guardedGame.id))?.homeScore).toBe(24);
    expect((await repository.getReport(guardedGame.id))?.revision.id).toBe(latest.id);
    expect((await db.query('SELECT 1 FROM source_snapshots WHERE id=$1', [rejectedSource.id])).rowCount).toBe(0);
    // Even an existing historical input hash cannot bypass the expected-base check.
    await expect(repository.saveAnalysis(guardedGame, [], [snapshot], { ...result(), events: [] }, 'clean', { expectedBaseRevisionId: first.id })).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('allows only one concurrent refresh to append against the same expected base', async () => {
    const guardedGame = { ...game, id: '2099_03_TST_DEMO', week: 3 };
    const first = await repository.saveAnalysis(guardedGame, [], [snapshot], { ...result(), events: [] }, 'clean');
    const saved = await Promise.allSettled([0.07, 0.08].map(value => repository.saveAnalysis(guardedGame, [], [snapshot], { ...result(value), events: [] }, 'clean', { expectedBaseRevisionId: first.id })));
    expect(saved.filter(entry => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = saved.find(entry => entry.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'revision_conflict' });
    expect((await repository.getReport(guardedGame.id))?.history).toHaveLength(2);
  });

  it('refreshes OT in an isolated real database without R or a source fetch, retaining metrics and old revisions',async()=>{
    const {loadGameProfileReference}=await import('../packages/core/src/game-profile-source.js');
    const {buildGameAudit,GAME_AUDIT_VERSION}=await import('../packages/core/src/game-audit.js');
    const {refreshGameAudit}=await import('../packages/core/src/audit-refresh.js');
    const {projectRoot}=await import('../packages/core/src/config.js');
    const path=await import('node:path');
    const historical=await loadGameProfileReference(path.join(process.env.MODEL_DIR??path.join(projectRoot,'analytics/models'),'game-profiles.json'));
    const otGame={...game,id:'2099_11_TST_DMO',homeTeam:'DMO',week:11,homeScore:0,awayScore:0,providerData:{synthetic:true,result:0}};
    const plays=Array.from({length:6},(_,index)=>({game_id:otGame.id,home_team:otGame.homeTeam,away_team:otGame.awayTeam,season:otGame.season,
      play_id:index,qtr:Math.max(1,index),time:'00:00',total_home_score:0,total_away_score:0,desc:index===0?'GAME':index===5?'END GAME':'Synthetic test row',play_type:'no_play'}));
    const profiles=[otGame.homeTeam,otGame.awayTeam].map(team=>({gameId:otGame.id,season:otGame.season,team,opponent:team===otGame.homeTeam?otGame.awayTeam:otGame.homeTeam,
      pointsFor:0,pointsAgainst:0,totalYards:0,opponentYards:0,penalties:0,penaltyYards:0,turnoverMargin:0,nonOffensiveTouchdowns:0}));
    const audit=buildGameAudit({game:otGame,plays,profiles,reference:historical.reference,referenceChecksum:historical.checksum});
    const sources=[{...snapshot,id:'synthetic-ot-pbp',provider:'nflverse-pbp'},{...snapshot,id:'synthetic-ot-aggregate',provider:'nflverse-team-stats'}];
    const original:AnalysisResult={...result(),events:[],gameAudit:audit,
      timeline:[{playId:'2',quarter:2,clock:'12:00',homeWp:0.42,description:'Stored regulation point'},{playId:'5',quarter:5,clock:'00:00',homeWp:null,description:'END GAME'}],
      models:[{id:'game-profile-audit',version:GAME_AUDIT_VERSION,checksum:historical.checksum}],warnings:[]};
    const first=await repository.saveAnalysis(otGame,plays,sources,original,'clean');
    const refreshed=await refreshGameAudit(otGame.id);
    expect(refreshed).toMatchObject({created:true,number:2});
    const latest=await repository.getReport(otGame.id);
    expect(latest?.revision.analysis.metrics).toEqual(original.metrics);
    expect(latest?.revision.analysis.timeline[0]).toEqual(original.timeline[0]);
    expect(latest?.revision.analysis.timeline.at(-1)).toMatchObject({status:'observed',homeWp:0,awayWp:0,tieProbability:1,reasonCode:'observed_terminal_result'});
    expect(latest?.revision.sourceSnapshots.map(source=>source.id).sort()).toEqual(sources.map(source=>source.id).sort());
    expect((await repository.getReport(otGame.id,1))?.revision).toMatchObject({id:first.id,analysis:original});
    expect(await refreshGameAudit(otGame.id)).toMatchObject({created:false,id:refreshed.id,number:2});
    expect((await repository.getReport(otGame.id))?.history).toHaveLength(2);
    expect((await db.query('SELECT 1 FROM publication_outbox WHERE game_id=$1',[otGame.id])).rowCount).toBe(0);
  });

  it('reads complete latest and historical reports with one pool checkout each',async()=>{
    const reportGame={...game,id:'2099_09_TST_DEMO',week:9};
    const oldSource={...snapshot,id:'synthetic-report-old',checksum:'1'.repeat(64),metadata:{synthetic:true,nested:{original:true}}};
    const newSource={...snapshot,id:'synthetic-report-new',checksum:'2'.repeat(64)};
    const analysis={...result(),events:[],metrics:[]};
    const first=await repository.saveAnalysis(reportGame,[],[oldSource],analysis,'clean');
    const changed={...reportGame,homeScore:20,providerData:{synthetic:true,result:10}};
    const second=await repository.saveAnalysis(changed,[],[newSource],{...analysis,warnings:['Synthetic changed report.']},'clean');
    const firstDate='2099-09-10T21:00:00.123Z';const secondDate='2099-09-10T22:00:00.456Z';
    const storedReview={id:'synthetic-stored-review',eventId:'synthetic-event',playId:'1',reviewer:'stored-reviewer',status:'supported',ruleSeason:2099,ruleReference:'Synthetic rule',evidenceUrl:'https://example.invalid/evidence',rationale:'Synthetic stored review.',confidence:'medium',scope:'Synthetic test only.',scopeComplete:true,approved:true,stale:false,createdAt:firstDate,replayCorrected:false};
    await db.query("UPDATE analysis_revisions SET created_at=$2,reviews_json=$3,review_status='reviewed_within_scope' WHERE id=$1",[first.id,firstDate,JSON.stringify([storedReview])]);
    await db.query("UPDATE analysis_revisions SET created_at=$2,reviews_json=$3,review_status='not_reviewed' WHERE id=$1",[second.id,secondDate,JSON.stringify([{...storedReview,stale:true}])]);
    const draftIds=[randomUUID(),randomUUID()];
    await db.query(`INSERT INTO publication_outbox(id,game_id,revision_id,kind,mode,status,text,evidence_ids,created_at,external_id,reason)
      VALUES($1,$2,$3,'initial','dry_run','draft','Old draft','[]',$4,null,'Original preview'),
      ($5,$2,$6,'correction','dry_run','approved','New draft','[]',$7,'synthetic-external','Changed preview')`,[draftIds[0],reportGame.id,first.id,firstDate,draftIds[1],second.id,secondDate]);
    // Mutable schedule state must never replace the game saved in a revision.
    await repository.saveGames([{...changed,homeScore:99}]);
    const checkout=vi.spyOn(db.pool,'query');
    try{
      const latest=await repository.getReport(reportGame.id);
      expect(checkout).toHaveBeenCalledTimes(1);checkout.mockClear();
      const archived=await repository.getReport(reportGame.id,1);
      expect(checkout).toHaveBeenCalledTimes(1);checkout.mockClear();
      expect(latest?.game).toEqual(changed);expect(archived?.game).toEqual(reportGame);
      expect(latest?.revision).toMatchObject({id:second.id,number:2,createdAt:secondDate,statisticalStatus:'corrected',reviewStatus:'not_reviewed',analysis:{warnings:['Synthetic changed report.']},sourceSnapshots:[newSource]});
      expect(archived?.revision).toMatchObject({id:first.id,number:1,createdAt:firstDate,statisticalStatus:'reconciled',reviewStatus:'reviewed_within_scope',analysis,sourceSnapshots:[oldSource]});
      expect(archived?.reviews).toEqual([storedReview]);expect(latest?.reviews).toEqual([{...storedReview,stale:true}]);
      expect(latest?.history.map(row=>({id:row.id,number:row.number,createdAt:row.createdAt}))).toEqual([{id:second.id,number:2,createdAt:secondDate},{id:first.id,number:1,createdAt:firstDate}]);
      expect(archived?.history).toEqual(latest?.history);
      expect(latest?.drafts).toEqual([
        {id:draftIds[1],gameId:reportGame.id,revisionId:second.id,text:'New draft',status:'approved',kind:'correction',mode:'dry_run',createdAt:secondDate,externalId:'synthetic-external',reason:'Changed preview'},
        {id:draftIds[0],gameId:reportGame.id,revisionId:first.id,text:'Old draft',status:'draft',kind:'initial',mode:'dry_run',createdAt:firstDate,externalId:null,reason:'Original preview'},
      ]);
      expect(archived?.drafts).toEqual(latest?.drafts);
      expect(await repository.getReport(reportGame.id,999)).toBeNull();expect(checkout).toHaveBeenCalledTimes(1);checkout.mockClear();
      expect(await repository.getReport('missing-synthetic-game')).toBeNull();expect(checkout).toHaveBeenCalledTimes(1);
    }finally{checkout.mockRestore();}
    const emptyGame={...reportGame,id:'2099_10_TST_DEMO',week:10};
    await repository.saveGames([emptyGame]);expect(await repository.getReport(emptyGame.id)).toBeNull();
    await repository.saveAnalysis(emptyGame,[],[],analysis,'clean');
    expect(await repository.getReport(emptyGame.id)).toMatchObject({revision:{sourceSnapshots:[]},drafts:[],reviews:[]});
  });
});
