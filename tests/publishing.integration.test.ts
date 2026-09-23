import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../packages/core/src/config.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '203.0.113.10', family: 4 }]) }));
const enabled = process.env.RUN_DB_TESTS === '1';
const namespace = `ur_test_${randomUUID().replaceAll('-', '')}`;
const original = { ...config };
const accountId = '123456789', adminId = randomUUID(), reviewerId = randomUUID();
const gameId = '2099_01_TST_DEMO', revisionId = randomUUID();
const reportUrl = `https://under-review.example/games/${gameId}?revision=1`;
const intendedText = `Synthetic test only. Calls not reviewed. ${reportUrl}`;
const labeledText = `Synthetic test only.\n\nSee the Review: ${reportUrl}\n\n#NFL #UnderReview`;
let admin: pg.Client;
let db: typeof import('../packages/core/src/db.js');
let publishing: typeof import('../packages/core/src/publishing.js');
let requests: { url: string; method: string }[];
let handler: (url: string, init?: RequestInit) => Promise<Response>;

async function makeOutbox(status = 'unknown_outcome', text = intendedText) {
  const id = randomUUID();
  let template='game-final-screening-v2';
  if(status==='approved'&&text===intendedText){const preview=await publishing.buildAutoPostPreview(gameId);text=preview.apiText;template=preview.apiTemplateVersion;}
  await db.query("INSERT INTO publication_outbox(id,game_id,revision_id,account_id,kind,mode,status,text,evidence_ids,template_version) VALUES($1,$2,$3,$4,'initial','live',$5,$6,'[]',$7)", [id, gameId, revisionId, accountId, status, text, template]);
  return id;
}
async function useNflTeamCodes(){
  const row=(await db.query('SELECT game_json,analysis FROM analysis_revisions WHERE id=$1',[revisionId])).rows[0];
  const game={...row.game_json,homeTeam:'NYJ',awayTeam:'GB'};
  row.analysis.gameAudit.profiles.forEach((profile:{team:string;opponent:string})=>{profile.team=profile.team==='DEMO'?'NYJ':'GB';profile.opponent=profile.opponent==='DEMO'?'NYJ':'GB';});
  await db.query('UPDATE analysis_revisions SET game_json=$2,analysis=$3 WHERE id=$1',[revisionId,JSON.stringify(game),JSON.stringify(row.analysis)]);
  await db.query("UPDATE games SET home_team='NYJ',away_team='GB',game_json=$2 WHERE id=$1",[gameId,JSON.stringify(game)]);
}
function postResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({ data: { id: '987654321', author_id: accountId, text: intendedText.replace(reportUrl, 'https://t.co/AbC123'), entities: { urls: [{ url: 'https://t.co/AbC123', expanded_url: reportUrl }] }, ...overrides } });
}
async function historicalDraft(){
  await db.query("UPDATE games SET publication_eligible=false,kickoff_at='1999-09-01',first_validated_at='1999-09-02' WHERE id=$1",[gameId]);
  return publishing.createDraft(gameId);
}

describe.skipIf(!enabled)('publication recovery (isolated PostgreSQL, all HTTP mocked)', () => {
  beforeAll(async () => {
    if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Unsafe test schema.');
    admin = new pg.Client({ connectionString: original.databaseUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${namespace}`);
    const connection = new URL(original.databaseUrl);
    connection.searchParams.set('options', `-c search_path=${namespace}`);
    Object.assign(config, { databaseUrl: connection.toString(), siteUrl: 'https://under-review.example', tokenEncryptionKey: '1'.repeat(64), staging: false, livePostingAllowed: true });
    db = await import('../packages/core/src/db.js');
    await db.migrate();
    publishing = await import('../packages/core/src/publishing.js');
    await db.query("INSERT INTO users(id,username,password_hash,role) VALUES($1,'synthetic-admin','unused','admin'),($2,'synthetic-reviewer','unused','reviewer')", [adminId, reviewerId]);
    await db.query("INSERT INTO games(id,season,week,game_type,home_team,away_team,game_json) VALUES($1,2099,1,'REG','DEMO','TST','{}')", [gameId]);
    await db.query("INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids) VALUES($1,$2,1,'synthetic','reconciled','unavailable','synthetic','synthetic','{}','[]')", [revisionId, gameId]);
  }, 60000);

  beforeEach(async () => {
    requests = [];
    handler = async () => { throw new Error('Unexpected test HTTP call.'); };
    vi.stubEnv('X_CLIENT_ID', 'synthetic-client');
    vi.stubEnv('X_CLIENT_SECRET', 'synthetic-secret');
    vi.stubEnv('X_REDIRECT_URI', 'https://under-review.example/api/x/callback');
    vi.stubEnv('X_EXPECTED_USERNAME', '');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); requests.push({ url, method: init?.method ?? 'GET' });
      return handler(url, init);
    }));
    await db.query('DELETE FROM publication_attempts');
    await db.query('DELETE FROM publication_outbox');
    await db.query('DELETE FROM jobs');
    await db.query('DELETE FROM audit_log');
    await db.query('DELETE FROM analysis_revisions WHERE number>1');
    const game={id:gameId,season:2099,week:1,gameType:'REG',homeTeam:'DEMO',awayTeam:'TST',homeScore:17,awayScore:20,kickoffAt:'2099-09-01T00:00:00Z',providerData:{}};
    await db.query("UPDATE games SET publication_eligible=true,first_validated_at='2099-09-01T04:00:00Z',kickoff_at=$1,game_json=$2 WHERE id=$3",[game.kickoffAt,JSON.stringify(game),gameId]);
    const profiles=[game.homeTeam,game.awayTeam].map(team=>({gameId,season:2099,team,opponent:team===game.homeTeam?game.awayTeam:game.homeTeam,pointsFor:team===game.homeTeam?17:20,pointsAgainst:team===game.homeTeam?20:17,totalYards:300,opponentYards:300,penalties:3,penaltyYards:20,turnoverMargin:0,nonOffensiveTouchdowns:0}));
    const analysis={gameAudit:{version:'under-review-game-audit-v4',status:'no_flag_found',headline:'Synthetic',profiles,flags:[],context:[],reviewCandidates:[],reference:{version:'synthetic',checksum:'a'.repeat(64),startSeason:2098,endSeason:2098,teamGames:2},notes:[]}};
    await db.query('UPDATE analysis_revisions SET game_json=$1,analysis=$2 WHERE id=$3',[JSON.stringify(game),JSON.stringify(analysis),revisionId]);
    await db.query("INSERT INTO oauth_accounts(id,username,encrypted_tokens,expires_at) VALUES($1,'synthetic-account',$2,now()+interval '1 hour') ON CONFLICT(id) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,expires_at=excluded.expires_at", [accountId, publishing.encryptTokens({ access_token: 'synthetic-old', refresh_token: 'synthetic-refresh', expires_in: 3600 })]);
    await db.query("UPDATE settings SET value=$1 WHERE key='publishing'", [JSON.stringify({ mode: 'automatic', killSwitch: false, accountId, activatedAt: '2000-01-01T00:00:00Z' })]);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => {
    await db?.pool.end();
    if (admin) {
      if (!/^ur_test_[a-f0-9]{32}$/.test(namespace)) throw new Error('Unsafe test cleanup.');
      await admin.query(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
      await admin.end();
    }
    Object.assign(config, original);
  });

  it.each([['legacy', intendedText], ['labeled', labeledText]])('binds the %s footer, intended author, complete text and expanded report URL, with durable audit', async (_format, text) => {
    const id = await makeOutbox('unknown_outcome', text);
    handler = async (url) => { expect(url).toBe('https://api.x.com/2/tweets/987654321?tweet.fields=author_id%2Centities'); return postResponse({ text: text.replace(reportUrl, 'https://t.co/AbC123') }); };
    await publishing.reconcilePublication(id, 'posted', '987654321', adminId);
    expect((await db.query('SELECT status,external_id FROM publication_outbox WHERE id=$1', [id])).rows[0]).toEqual({ status: 'published', external_id: '987654321' });
    expect((await db.query('SELECT details FROM audit_log')).rows[0].details).toMatchObject({ resolution: 'posted', verified: true, accountId });
    expect(requests.map(request => request.method)).toEqual(['GET']);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('reconciles exact URL-free v4 text with its intended author and internal report revision',async()=>{
    const preview=await publishing.buildAutoPostPreview(gameId),id=await makeOutbox('unknown_outcome',preview.apiText);
    await db.query("UPDATE publication_outbox SET template_version='game-final-screening-v4-names' WHERE id=$1",[id]);
    expect(preview.apiText).not.toMatch(/https?:\/\/|See the Review:/);
    handler=async()=>postResponse({text:preview.apiText,entities:{urls:[]}});
    await publishing.reconcilePublication(id,'posted','987654321',adminId);
    expect((await db.query('SELECT status,external_id,revision_id FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual({status:'published',external_id:'987654321',revision_id:revisionId});
    expect((await db.query('SELECT details FROM audit_log')).rows[0].details).toMatchObject({verified:true,accountId,revisionId,templateVersion:'game-final-screening-v4-names'});
    expect(requests.map(request=>request.method)).toEqual(['GET']);expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(0);
  });

  it.each(['wrong-author','changed-text','legacy-version','unknown-version','embedded-url','changed-revision'])('keeps URL-free v4 %s uncertain without resending',async failure=>{
    const preview=await publishing.buildAutoPostPreview(gameId),text=failure==='embedded-url'?labeledText:preview.apiText,id=await makeOutbox('unknown_outcome',text);
    const version=failure==='legacy-version'?'game-final-screening-v3-names':failure==='unknown-version'?'unknown-template':'game-final-screening-v4-names';
    await db.query('UPDATE publication_outbox SET template_version=$2 WHERE id=$1',[id,version]);
    handler=async()=>{
      if(failure==='changed-revision'){
        const nextRevision=randomUUID();
        await db.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json) SELECT $1,game_id,2,'reconcile-race',statistical_status,charting_status,'synthetic',summary,analysis,snapshot_ids,game_json FROM analysis_revisions WHERE id=$2`,[nextRevision,revisionId]);
        await db.query('UPDATE publication_outbox SET revision_id=$2 WHERE id=$1',[id,nextRevision]);
      }
      return postResponse({text:failure==='changed-text'?`${text}\nChanged`:text,author_id:failure==='wrong-author'?'999':accountId,entities:{urls:[]}});
    };
    await expect(publishing.reconcilePublication(id,'posted','987654321',adminId)).rejects.toThrow();
    expect((await db.query('SELECT status,external_id FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual({status:'unknown_outcome',external_id:null});
    expect(requests.map(request=>request.method)).toEqual(['GET']);expect((await db.query('SELECT count(*)::int n FROM publication_attempts')).rows[0].n).toBe(0);
  });

  it.each(['changed-remote-footer', 'different-revision-url', 'different-footer', 'trailing-text'])('rejects a labeled post with %s and keeps the outcome uncertain', async failure => {
    const text = failure === 'different-revision-url' ? labeledText.replace('?revision=1', '?revision=2')
      : failure === 'different-footer' ? labeledText.replace('#UnderReview', '#Other')
      : failure === 'trailing-text' ? `${labeledText}\nMore text` : labeledText;
    const id = await makeOutbox('unknown_outcome', text);
    // Matching invalid stored/remote text must still fail the canonical footer guard.
    const remoteText = failure === 'changed-remote-footer' ? text.replace('#UnderReview', '#Other') : text;
    handler = async () => postResponse({ text: remoteText.replace(reportUrl, 'https://t.co/AbC123') });
    await expect(publishing.reconcilePublication(id, 'posted', '987654321', adminId)).rejects.toThrow('exactly match');
    expect((await db.query('SELECT status,external_id FROM publication_outbox WHERE id=$1', [id])).rows[0]).toEqual({ status: 'unknown_outcome', external_id: null });
    expect(requests.map(request => request.method)).toEqual(['GET']);
    expect((await db.query('SELECT count(*)::int AS n FROM publication_attempts')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('shows credential/account readiness and an attributable preview without calling X',async()=>{
    const ready=await publishing.getPublishingReadiness();expect(ready).toMatchObject({connectionReady:true,automaticReady:true,cutoffPolicy:'kickoff_after_activation',corrections:'manual_only',selectedAccount:{id:accountId}});
    const preview=await publishing.buildAutoPostPreview(gameId);expect(preview).toMatchObject({valid:true,revision:1,eligibleForAutomation:true,reportUrl});expect(preview.text).toContain('TST 20 — DEMO 17\n\n🟢 FAIR — 1/5');
    vi.stubEnv('X_EXPECTED_USERNAME','riggednflmoment');expect((await publishing.getPublishingReadiness()).automaticReady).toBe(false);
    vi.stubEnv('X_REDIRECT_URI','https://attacker.example/callback');expect((await publishing.getPublishingReadiness()).connectionReady).toBe(false);
    await expect(publishing.beginXConnection(adminId)).rejects.toThrow('exact callback');expect(requests).toHaveLength(0);
  });
  it('refreshes the same unapproved dry-run revision with current text, evidence, template and matching metadata',async()=>{
    await useNflTeamCodes();const first=await publishing.createDraft(gameId);
    await db.query("UPDATE publication_outbox SET text='Old template',evidence_ids='[\"old-evidence\"]',template_version='game-final-screening-v2',reason='Old preview' WHERE id=$1",[first.id]);
    const expected=await publishing.buildAutoPostPreview(gameId),again=await publishing.createDraft(gameId);
    expect(again).toEqual({id:first.id,text:expected.text,evidenceIds:expected.evidenceIds,weightedLength:expected.weightedLength,valid:true});
    expect((await db.query('SELECT text,evidence_ids,template_version,status,approved_by,reason FROM publication_outbox WHERE id=$1',[first.id])).rows[0]).toEqual({text:expected.text,evidence_ids:expected.evidenceIds,template_version:expected.templateVersion,status:'draft',approved_by:null,reason:'Dry-run preview.'});
    expect((await db.query('SELECT count(*)::int n FROM publication_outbox')).rows[0].n).toBe(1);expect(requests).toHaveLength(0);
  });
  it('preserves an approved dry-run and reports metadata for its stored historical text',async()=>{
    const draft=await publishing.createDraft(gameId),oldText='Previously approved preview';
    await db.query("UPDATE publication_outbox SET text=$2,evidence_ids='[\"old-evidence\"]',template_version='game-final-screening-v2',status='approved',approved_by=$3 WHERE id=$1",[draft.id,oldText,adminId]);
    const before=(await db.query('SELECT * FROM publication_outbox WHERE id=$1',[draft.id])).rows[0],again=await publishing.createDraft(gameId);
    expect(again).toEqual({id:draft.id,text:oldText,evidenceIds:['old-evidence'],weightedLength:oldText.length,valid:false});
    expect((await db.query('SELECT * FROM publication_outbox WHERE id=$1',[draft.id])).rows[0]).toEqual(before);expect(requests).toHaveLength(0);
  });

  it('requires a separate administrator authorization; automatic and ordinary approval keep the cutoff',async()=>{
    const draft=await historicalDraft();
    await expect(publishing.approveDraft(draft.id,adminId)).rejects.toThrow('Historical backfills');
    await expect(publishing.approveDraft(draft.id,reviewerId,{authorizeHistoricalInitial:true})).rejects.toThrow('Administrator');
    await publishing.maybeAutomaticDraft(gameId);
    expect((await db.query("SELECT count(*)::int n FROM publication_outbox WHERE mode='live'")).rows[0].n).toBe(0);expect(requests).toHaveLength(0);
  });

  it('records only the selected historical initial post, using fresh canonical text and atomic queueing',async()=>{
    const draft=await historicalDraft();const settings=await publishing.getPublishingSettings();
    await db.query("UPDATE publication_outbox SET text='Outdated stored preview',template_version='old-template' WHERE id=$1",[draft.id]);
    const expected=await publishing.buildAutoPostPreview(gameId);
    const id=await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true});
    expect((await db.query('SELECT manual_historical_initial,queued_automatically,approved_by,text,template_version FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual({manual_historical_initial:true,queued_automatically:false,approved_by:adminId,text:expected.apiText,template_version:expected.apiTemplateVersion});
    expect((await db.query('SELECT details FROM audit_log WHERE target=$1',[id])).rows[0].details).toMatchObject({manualHistoricalInitial:true,automatic:false,accountId,revisionId});
    expect((await db.query('SELECT publication_eligible FROM games WHERE id=$1',[gameId])).rows[0].publication_eligible).toBe(false);
    expect(await publishing.getPublishingSettings()).toEqual(settings);
    expect(await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true})).toBeNull();
    expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(1);
    handler=async(url,init)=>{if(url===reportUrl)return new Response('synthetic report');expect(url).toBe('https://api.x.com/2/tweets');expect(JSON.parse(String(init?.body))).toEqual({text:expected.apiText});expect(expected.apiText).not.toMatch(/https?:\/\/|See the Review:/);return Response.json({data:{id:'987654321'}},{status:201});};
    await publishing.publishOutbox(id);expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1',[id])).rows[0].status).toBe('published');
    await publishing.maybeAutomaticDraft(gameId);expect((await db.query("SELECT count(*)::int n FROM publication_outbox WHERE mode='live'")).rows[0].n).toBe(1);
  });

  it.each(['published','unknown_outcome','cancelled'])('never replaces a %s initial publication with historical authorization',async status=>{
    const existing=await makeOutbox(status);const draft=await historicalDraft();
    expect(await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true})).toBeNull();
    expect((await db.query('SELECT status,manual_historical_initial,text FROM publication_outbox WHERE id=$1',[existing])).rows[0]).toEqual({status,manual_historical_initial:false,text:intendedText});
    expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(0);expect(requests).toHaveLength(0);
  });

  it.each([401,429])('retains historical authorization through an explicit HTTP %i retry',async status=>{
    const draft=await historicalDraft();const id=await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true});let submissions=0;
    handler=async url=>{if(url===reportUrl)return new Response('synthetic report');if(url.endsWith('/oauth2/token'))return Response.json({access_token:'synthetic-fresh',refresh_token:'synthetic-refresh',expires_in:3600});expect(url).toBe('https://api.x.com/2/tweets');return ++submissions===1?new Response(null,{status}):Response.json({data:{id:'987654321'}},{status:201});};
    await publishing.publishOutbox(id);expect((await db.query('SELECT status,manual_historical_initial FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual({status:'approved',manual_historical_initial:true});
    expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(2);
    await publishing.publishOutbox(id);expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1',[id])).rows[0].status).toBe('published');expect(submissions).toBe(2);
  });

  it('does not retry an ambiguous historical submission even after another explicit approval',async()=>{
    const draft=await historicalDraft();const id=await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true});
    handler=async url=>url===reportUrl?new Response('synthetic report'):new Response(null,{status:503});
    await publishing.publishOutbox(id);expect(await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true})).toBeNull();await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,manual_historical_initial FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual({status:'unknown_outcome',manual_historical_initial:true});
    expect(requests.filter(request=>request.method==='POST')).toHaveLength(1);expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(1);
  });

  it.each(['kill-switch','draft-only','unrated'])('keeps the %s guard for explicit historical approval',async guard=>{
    const draft=await historicalDraft();
    if(guard==='unrated')await db.query("UPDATE analysis_revisions SET analysis='{}' WHERE id=$1",[revisionId]);
    else await db.query("UPDATE settings SET value=jsonb_set(value,$1,$2) WHERE key='publishing'",[guard==='kill-switch'?'{killSwitch}':'{mode}',guard==='kill-switch'?'true':'"draft-only"']);
    await expect(publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true})).rejects.toThrow();expect((await db.query("SELECT count(*)::int n FROM publication_outbox WHERE mode='live'")).rows[0].n).toBe(0);expect(requests).toHaveLength(0);
  });

  it('enforces the persisted manual-only authorization invariant in PostgreSQL',async()=>{
    const id=await makeOutbox('approved');await expect(db.query('UPDATE publication_outbox SET manual_historical_initial=true WHERE id=$1',[id])).rejects.toThrow('manual_historical_initial_requires_approval');
    const draft=await historicalDraft();await expect(db.query('UPDATE publication_outbox SET manual_historical_initial=true,approved_by=$2 WHERE id=$1',[draft.id,adminId])).rejects.toThrow('manual_historical_initial_requires_approval');
  });

  it('atomically queues one initial post per game/account and does not post revisions automatically',async()=>{
    // More callers than the pool's five connections catches nested-checkout deadlocks.
    await Promise.all(Array.from({length:7},()=>publishing.maybeAutomaticDraft(gameId)));
    expect((await db.query("SELECT count(*)::int n FROM publication_outbox WHERE mode='live'")).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(1);
    await db.query("UPDATE publication_outbox SET status='published',external_id='987654321' WHERE mode='live'");
    await db.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json) SELECT $1,game_id,2,'synthetic2',statistical_status,charting_status,'correction',summary,analysis,snapshot_ids,game_json FROM analysis_revisions WHERE id=$2`,[randomUUID(),revisionId]);
    await publishing.maybeAutomaticDraft(gameId);
    expect((await db.query('SELECT count(*)::int n FROM publication_outbox')).rows[0].n).toBe(2);
    expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(1);
    expect((await publishing.buildAutoPostPreview(gameId)).ineligibilityReason).toContain('already has');expect(requests).toHaveLength(0);
  });
  it('renders the latest scored report instead of reusing an older dry-run preview',async()=>{
    const old=await publishing.createDraft(gameId);
    const newRevision=randomUUID();
    await db.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json) SELECT $1,game_id,2,'corrected-final',statistical_status,charting_status,'corrected final',summary,jsonb_set(jsonb_set(analysis,'{gameAudit,profiles,0,pointsFor}','21'),'{gameAudit,profiles,1,pointsAgainst}','21'),snapshot_ids,jsonb_set(game_json,'{homeScore}','21') FROM analysis_revisions WHERE id=$2`,[newRevision,revisionId]);
    await publishing.maybeAutomaticDraft(gameId);
    const live=(await db.query("SELECT revision_id,text FROM publication_outbox WHERE mode='live'")).rows[0];expect(live.revision_id).toBe(newRevision);expect(live.text).toContain('TST 20 — DEMO 21');expect(live.text.endsWith('\n\n#NFL #UnderReview')).toBe(true);expect(live.text).not.toMatch(/https?:\/\/|See the Review:/);
    expect((await db.query('SELECT text FROM publication_outbox WHERE id=$1',[old.id])).rows[0].text).toContain('TST 20 — DEMO 17');expect(requests).toHaveLength(0);
  });
  it('queues automatic team names while retaining the manual handle preview',async()=>{
    await useNflTeamCodes();const preview=await publishing.buildAutoPostPreview(gameId);
    expect(preview.text).toContain('Week 1: @Packers 20 — @NYJets 17');expect(preview.apiText).toContain('Week 1: Packers 20 — Jets 17');
    await publishing.maybeAutomaticDraft(gameId);
    const rows=(await db.query('SELECT mode,text,template_version FROM publication_outbox ORDER BY mode')).rows;
    expect(rows).toEqual([{mode:'dry_run',text:preview.text,template_version:'game-final-screening-v4'},{mode:'live',text:preview.apiText,template_version:'game-final-screening-v4-names'}]);expect(rows.every(row=>!row.text.includes('https://')&&!row.text.includes('See the Review:'))).toBe(true);expect(requests).toHaveLength(0);
  });
  it.each(['initial','update','correction'] as const)('renders approved manual API %s posts with names without rewriting their previews',async kind=>{
    await useNflTeamCodes();
    if(kind!=='initial')await db.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json) SELECT $1,game_id,2,'manual-update',statistical_status,charting_status,'manual update',summary,analysis,snapshot_ids,game_json FROM analysis_revisions WHERE id=$2`,[randomUUID(),revisionId]);
    const draft=await publishing.createDraft(gameId,kind);expect(draft.text).toContain('@Packers');
    const id=await publishing.approveDraft(draft.id,adminId),live=(await db.query('SELECT text,template_version FROM publication_outbox WHERE id=$1',[id])).rows[0];
    expect(live.text).toContain('Week 1: Packers 20 — Jets 17');expect(live.text).not.toContain('@');expect(live.text).not.toMatch(/https?:\/\/|See the Review:/);expect(live.template_version).toBe('game-final-screening-v4-names');
    if(kind!=='initial')expect(live.text).toContain(kind==='correction'?'Correction:':'Update:');
    expect((await db.query('SELECT text FROM publication_outbox WHERE id=$1',[draft.id])).rows[0].text).toBe(draft.text);expect(requests).toHaveLength(0);
  });
  it('uses names for explicitly approved historical API posts, keeping their handle previews untouched',async()=>{
    await useNflTeamCodes();const draft=await historicalDraft();const id=await publishing.approveDraft(draft.id,adminId,{authorizeHistoricalInitial:true});
    expect(draft.text).toContain('@Packers');const live=(await db.query('SELECT text,manual_historical_initial FROM publication_outbox WHERE id=$1',[id])).rows[0];expect(live.text).toContain('Packers 20 — Jets 17');expect(live.text).not.toContain('@');expect(live.manual_historical_initial).toBe(true);expect(requests).toHaveLength(0);
  });
  it.each(['game-final-screening-v2','game-final-screening-v3','game-final-screening-v3-names'])('stops stale %s live rows before network access and never upgrades them through a newer automatic revision',async version=>{
    const id=await makeOutbox('approved');await db.query('UPDATE publication_outbox SET template_version=$2,queued_automatically=true WHERE id=$1',[id,version]);
    const before=(await db.query('SELECT text,revision_id FROM publication_outbox WHERE id=$1',[id])).rows[0];
    await db.query(`INSERT INTO analysis_revisions(id,game_id,number,input_hash,statistical_status,charting_status,change_summary,summary,analysis,snapshot_ids,game_json) SELECT $1,game_id,2,'newer-template',statistical_status,charting_status,'new revision',summary,analysis,snapshot_ids,game_json FROM analysis_revisions WHERE id=$2`,[randomUUID(),revisionId]);
    await publishing.maybeAutomaticDraft(gameId);await publishing.publishOutbox(id);
    expect((await db.query('SELECT text,revision_id,template_version,status,reason FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual({...before,template_version:version,status:'failed',reason:expect.stringContaining('stale')});expect(requests).toHaveLength(0);expect((await db.query('SELECT count(*)::int n FROM publication_attempts')).rows[0].n).toBe(0);
  });
  it('rejects altered current-version API text before checking the report or calling X',async()=>{
    await useNflTeamCodes();const id=await makeOutbox('approved');await db.query("UPDATE publication_outbox SET text=replace(text,'Packers','@Packers') WHERE id=$1",[id]);
    await publishing.publishOutbox(id);expect((await db.query('SELECT status,reason,text FROM publication_outbox WHERE id=$1',[id])).rows[0]).toMatchObject({status:'failed',reason:expect.stringContaining('canonical team-name'),text:expect.stringContaining('@Packers')});expect(requests).toHaveLength(0);
  });
  it.each(['published','unknown_outcome'])('does not rewrite %s historical text or template during delivery checks',async status=>{
    const id=await makeOutbox(status);const before=(await db.query('SELECT status,text,template_version,updated_at FROM publication_outbox WHERE id=$1',[id])).rows[0];
    await publishing.publishOutbox(id);expect((await db.query('SELECT status,text,template_version,updated_at FROM publication_outbox WHERE id=$1',[id])).rows[0]).toEqual(before);expect(requests).toHaveLength(0);
  });
  it('waits for a complete rating without consuming the initial slot, then queues once',async()=>{
    const saved=(await db.query('SELECT analysis FROM analysis_revisions WHERE id=$1',[revisionId])).rows[0].analysis;
    await db.query("UPDATE analysis_revisions SET analysis='{}' WHERE id=$1",[revisionId]);
    await publishing.maybeAutomaticDraft(gameId);expect((await db.query('SELECT count(*)::int n FROM publication_outbox')).rows[0].n).toBe(0);
    expect((await publishing.buildAutoPostPreview(gameId)).ineligibilityReason).toContain('complete game rating');
    await db.query('UPDATE analysis_revisions SET analysis=$2 WHERE id=$1',[revisionId,JSON.stringify(saved)]);await publishing.maybeAutomaticDraft(gameId);
    expect((await db.query("SELECT count(*)::int n FROM publication_outbox WHERE mode='live'")).rows[0].n).toBe(1);
    await db.query("UPDATE analysis_revisions SET analysis='{}' WHERE id=$1",[revisionId]);const id=(await db.query("SELECT id FROM publication_outbox WHERE mode='live'")).rows[0].id;
    await publishing.publishOutbox(id);expect(requests).toHaveLength(0);expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1',[id])).rows[0]).toMatchObject({status:'approved',reason:expect.stringContaining('complete current game rating')});
  });

  it.each(['backfill','early-kickoff','missing-kickoff','prevalidated'])('excludes %s without failing analysis or queuing a historical post',async reason=>{
    if(reason==='backfill')await db.query('UPDATE games SET publication_eligible=false');
    if(reason==='early-kickoff')await db.query("UPDATE games SET kickoff_at='1999-01-01'");
    if(reason==='missing-kickoff')await db.query('UPDATE games SET kickoff_at=null');
    if(reason==='prevalidated')await db.query("UPDATE games SET first_validated_at='1999-01-01'");
    await publishing.maybeAutomaticDraft(gameId);expect((await db.query('SELECT count(*)::int n FROM publication_outbox')).rows[0].n).toBe(0);expect(requests).toHaveLength(0);
  });

  it('rolls back the live row if enqueueing fails, then analysis retry can recover without another preview',async()=>{
    await db.query("ALTER TABLE jobs ADD CONSTRAINT synthetic_reject_publish CHECK(kind<>'publish')");
    try{await expect(publishing.maybeAutomaticDraft(gameId)).rejects.toThrow();expect((await db.query("SELECT count(*)::int n FROM publication_outbox WHERE mode='live'")).rows[0].n).toBe(0);}
    finally{await db.query('ALTER TABLE jobs DROP CONSTRAINT synthetic_reject_publish');}
    await publishing.maybeAutomaticDraft(gameId);expect((await db.query('SELECT count(*)::int n FROM publication_outbox')).rows[0].n).toBe(2);expect((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(1);expect(requests).toHaveLength(0);
  });

  it('requires the expected account and refreshes the cutoff only when automation resumes',async()=>{
    vi.stubEnv('X_EXPECTED_USERNAME','riggednflmoment');await expect(publishing.setPublishing('automatic',accountId,adminId)).rejects.toThrow('intended X account');
    await expect(publishing.setKillSwitch(false,adminId)).rejects.toThrow('intended X account');vi.stubEnv('X_EXPECTED_USERNAME','');
    await publishing.setKillSwitch(true,adminId);await publishing.setKillSwitch(false,adminId);const settings=await publishing.getPublishingSettings();expect(Date.parse(settings.activatedAt!)).toBeGreaterThan(Date.now()-5000);
    await publishing.setKillSwitch(false,adminId);expect((await publishing.getPublishingSettings()).activatedAt).toBe(settings.activatedAt);expect(requests).toHaveLength(0);
  });

  it('rechecks the cutoff at delivery and never submits a stale initial post',async()=>{
    const id=await makeOutbox('approved');await db.query("UPDATE games SET kickoff_at='1999-01-01'");await publishing.publishOutbox(id);
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1',[id])).rows[0].status).toBe('cancelled');expect(requests).toHaveLength(0);
  });

  it.each(['wrong-author', 'changed-text', 'wrong-url', 'missing-post'])('keeps %s uncertain and never resends', async (failure) => {
    const id = await makeOutbox();
    handler = async () => failure === 'missing-post' ? new Response(null, { status: 404 }) : postResponse(failure === 'wrong-author' ? { author_id: '999' } : failure === 'changed-text' ? { text: 'Different text.' } : { entities: { urls: [{ url: 'https://t.co/AbC123', expanded_url: 'https://attacker.example/' }] } });
    await expect(publishing.reconcilePublication(id, 'posted', '987654321', adminId)).rejects.toThrow();
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1', [id])).rows[0].status).toBe('unknown_outcome');
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('requires an administrator and permits permanent cancellation without network or resend', async () => {
    const id = await makeOutbox();
    await expect(publishing.reconcilePublication(id, 'cancel', null, reviewerId)).rejects.toThrow('Administrator');
    await expect(publishing.reconcilePublication(id, 'posted', 'https://attacker.example/', adminId)).rejects.toThrow('numeric X post ID');
    await publishing.reconcilePublication(id, 'cancel', null, adminId);
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'cancelled', reason: expect.stringContaining('may remain unknown') });
    expect(requests).toHaveLength(0);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('keeps an explicit 401 failed when token refresh fails, without treating it as an uncertain post', async () => {
    const id = await makeOutbox('approved');
    handler = async (url) => {
      if (url === reportUrl) return new Response('synthetic report');
      if (url === 'https://api.x.com/2/tweets') return new Response(null, { status: 401 });
      if (url === 'https://api.x.com/2/oauth2/token') throw new Error('Synthetic token endpoint outage.');
      throw new Error('Unexpected test URL.');
    };
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('token refresh failed') });
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
  });

  it('refreshes a rejected 401 once and queues a separate attempt atomically', async () => {
    const id = await makeOutbox('approved');
    handler = async (url) => {
      if (url === reportUrl) return new Response('synthetic report');
      if (url === 'https://api.x.com/2/oauth2/token') return Response.json({ access_token: 'synthetic-fresh', refresh_token: 'synthetic-rotated', expires_in: 3600 });
      if (url === 'https://api.x.com/2/tweets') return new Response(null, { status: 401 });
      throw new Error('Unexpected test URL.');
    };
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status,reason FROM publication_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ status: 'approved', reason: expect.stringContaining('explicit retry queued') });
    expect((await db.query('SELECT state,http_status FROM publication_attempts')).rows[0]).toEqual({ state: 'retry', http_status: 401 });
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
    const encrypted = (await db.query('SELECT encrypted_tokens FROM oauth_accounts')).rows[0].encrypted_tokens;
    expect(publishing.decryptTokens(encrypted).access_token).toBe('synthetic-fresh');
    expect(requests.filter(request => request.url.endsWith('/2/tweets'))).toHaveLength(1);
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1', [id])).rows[0].status).toBe('failed');
    expect(requests.filter(request => request.url.endsWith('/oauth2/token'))).toHaveLength(1);
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(1);
  });

  it.each(['timeout', 'server-error', 'success-without-id'])('preserves unknown outcome after %s without token refresh or retry job', async (failure) => {
    const id = await makeOutbox('approved');
    handler = async (url) => {
      if (url === reportUrl) return new Response('synthetic report');
      if (url === 'https://api.x.com/2/tweets') {
        if (failure === 'timeout') throw new Error('Synthetic network interruption.');
        return Response.json({}, { status: failure === 'server-error' ? 503 : 201 });
      }
      throw new Error('Unexpected test URL.');
    };
    await publishing.publishOutbox(id);
    expect((await db.query('SELECT status FROM publication_outbox WHERE id=$1', [id])).rows[0].status).toBe('unknown_outcome');
    expect((await db.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
    expect(requests.filter(request => request.url.endsWith('/oauth2/token'))).toHaveLength(0);
  });
});
