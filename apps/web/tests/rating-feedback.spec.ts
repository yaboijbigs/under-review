import { test,expect,type Page } from '@playwright/test';

const ownEndpoint=(id:string)=>new RegExp('/api/games/'+id+'/feedback(?:\\?.*)?$');
const gameId=process.env.SMOKE_AUDIT_GAME_ID;
const gameUrl=()=>'/games/'+gameId;
const archiveUrl=()=>process.env.SMOKE_SEASON?'/?season='+encodeURIComponent(process.env.SMOKE_SEASON):'/';
type Saved={agreement:'agree'|'disagree';rating:number|null;comment:string;public:boolean};
const totals=(saved:Saved|null)=>({total:saved?.public?1:0,agree:saved?.public&&saved.agreement==='agree'?1:0,disagree:saved?.public&&saved.agreement==='disagree'?1:0,ratingCount:saved?.public&&saved.rating!==null?1:0,averageRating:saved?.public?saved.rating:null,ratings:[]});
async function mockFeedback(page:Page,initial:Saved|null=null,gate?:Promise<void>){
 let saved=initial;const submissions:Record<string,unknown>[]=[];
 // All writes are intercepted: never create synthetic public votes.
 await page.route(ownEndpoint(gameId!),async route=>{
  if(route.request().method()==='GET'){await gate;return route.fulfill({json:{feedback:saved,summary:saved?totals(saved):null}});}
  const body=route.request().postDataJSON();submissions.push(body);
  saved={agreement:body.agreement,rating:body.action==='thumb'?(saved?.public?saved.rating:null):body.rating,comment:body.action==='thumb'?(saved?.public?saved.comment:''):body.comment.trim(),public:body.public};
  await route.fulfill({json:{feedback:saved,summary:totals(saved)}});
 });
 await page.route('**/api/games/'+gameId+'/feedback/public?*',route=>route.fulfill({json:{entries:saved?.public&&saved.comment.trim()?[{...saved,id:'public-feedback',revisionId:'saved',revisionNumber:1,modelRating:1,rulesVersion:'game-suspicion-v2',updatedAt:'2026-09-23T12:00:00Z'}]:[],nextCursor:null,summary:totals(saved)}}));
 return submissions;
}
test.beforeEach(async({page})=>{
 test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to a rated report.');
 await page.route('**/api/games/*/feedback/public?*',route=>route.fulfill({json:{entries:[],nextCursor:null,summary:totals(null)}}));
});
test('a thumb saves one public response and optional details enrich that response',async({page},info)=>{
 test.setTimeout(60_000);const posts=await mockFeedback(page);await page.goto(gameUrl());const widget=page.locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await expect(widget.getByRole('slider')).toHaveCount(0);await expect(widget.getByRole('button',{name:'Agree',exact:true})).toHaveAccessibleDescription('Your vote is public.');
 await widget.getByRole('button',{name:'Disagree',exact:true}).click();await expect(widget.getByRole('status')).toContainText('public response is saved');expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({action:'thumb',agreement:'disagree',rating:null,comment:'',public:true});
 if(process.env.SMOKE_OFFICIATING==='true')expect(posts[0]).toMatchObject({rulesVersion:'game-suspicion-v4',modelRating:Number(await page.locator('.game-verdict').getAttribute('data-rating'))});
 else if(process.env.SMOKE_EXPECTATIONS==='true')expect(posts[0]).toMatchObject({rulesVersion:'game-suspicion-v3',modelRating:Number(await page.locator('.game-verdict').getAttribute('data-rating'))});
 await expect(widget.getByRole('textbox')).toHaveAccessibleName('Why? (optional, public)');
 await expect(page.locator('#fan-feedback .feedback-empty')).toContainText('No comments yet');await expect(page.locator('#fan-feedback article')).toHaveCount(0);await expect(page.locator('.public-feedback-summary > div').first().locator('strong')).toHaveText('1');
 const slider=widget.getByRole('slider');await expect(slider).toHaveAttribute('aria-valuetext','No rating selected. Move the slider to add one.');await expect(page.locator('.public-feedback-summary')).toContainText('No slider ratings yet');
 await slider.focus();await slider.press('Home');await slider.press('ArrowRight');await widget.getByRole('textbox',{name:/Why/}).fill('The last drive changed my view.');await widget.getByRole('button',{name:'Save details',exact:true}).click();
 await expect(widget.getByRole('status')).toContainText('public response is saved');expect(posts).toHaveLength(2);expect(posts[1]).toMatchObject({action:'details',rating:2,comment:'The last drive changed my view.',public:true});await expect(widget).toContainText('0 agree · 1 disagree · 1 response');await expect(page.locator('#fan-feedback .visitor-comment')).toHaveText('The last drive changed my view.');await expect(page.locator('.public-feedback-summary')).toContainText('From 1 slider rating');
 await page.reload();await expect(widget.getByRole('status')).toContainText('public response is saved',{timeout:20000});await expect(page.locator('main .notice')).toHaveCount(0);await expect(widget.getByRole('slider')).toHaveValue('2');
 await widget.screenshot({path:info.outputPath('feedback-saved.png')});const market=page.locator('.market-comparison[aria-labelledby="market-title"]');if(process.env.SMOKE_MARKET_EXPECTED==='true')await expect(market.locator('.market-numbers')).toBeVisible();if(await market.count())await market.screenshot({path:info.outputPath('market-comparison.png')});
});
test('home cards show counted public feedback to the right of thumbs without eager requests',async({page},info)=>{
 test.setTimeout(60_000);const posts=await mockFeedback(page),requests:string[]=[];
 page.on('request',request=>{if(request.method()==='GET'&&/\/api\/games\/[^/]+\/feedback(?:\?|$)/.test(request.url()))requests.push(request.url());});
 await page.goto(archiveUrl());const card=page.locator('.game-card').filter({has:page.locator('.scoreboard-link[href="'+gameUrl()+'"]')}),widget=card.locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await page.waitForLoadState('networkidle');expect(requests).toHaveLength(0);await expect(widget.getByRole('slider')).toHaveCount(0);
 const link=widget.getByRole('link',{name:/See Public Feedback \(\d+\)/});await expect(link).toHaveAttribute('href',gameUrl()+'#fan-feedback');const positions=await Promise.all([widget.locator('.feedback-choices').boundingBox(),link.boundingBox()]);expect(positions[1]!.x).toBeGreaterThanOrEqual(positions[0]!.x+positions[0]!.width);
 await widget.getByRole('button',{name:'Agree',exact:true}).click();await expect(widget.getByRole('status')).toContainText('public response is saved');expect(requests).toHaveLength(1);expect(posts).toHaveLength(1);await expect(link).toHaveText('See Public Feedback (1)');
 await widget.getByRole('textbox',{name:/Why/}).fill('One response with an explanation.');await widget.getByRole('button',{name:'Save details',exact:true}).click();await expect(widget.getByRole('status')).toContainText('public response is saved');expect(posts[1]).toMatchObject({rating:null,comment:'One response with an explanation.'});await expect(link).toHaveText('See Public Feedback (1)');
 expect(await card.locator('a form, form form, a button').count()).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await card.screenshot({path:info.outputPath('home-feedback-expanded.png')});
});
test('a returning visitor changes a home thumb without losing saved details',async({page})=>{
 const posts=await mockFeedback(page,{agreement:'agree',rating:4,comment:'Three critical flags on one drive.',public:true});await page.goto(archiveUrl());const widget=page.locator('.game-card').filter({has:page.locator('.scoreboard-link[href="'+gameUrl()+'"]')}).locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await widget.getByRole('button',{name:'Disagree',exact:true}).click();await expect(widget.getByRole('status')).toContainText('public response is saved');await expect(widget.getByRole('slider')).toHaveValue('4');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Three critical flags on one drive.');expect(posts).toHaveLength(1);expect(posts[0]).toMatchObject({action:'thumb',agreement:'disagree'});await expect(widget.getByRole('link')).toHaveText('See Public Feedback (1)');
});
test('a delayed saved response preserves new rating and explanation edits',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const posts=await mockFeedback(page,{agreement:'agree',rating:1,comment:'Earlier view.',public:true},gate);await page.goto(gameUrl());const widget=page.locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await widget.getByRole('button',{name:'Disagree',exact:true}).click();await widget.getByRole('slider').focus();await widget.getByRole('slider').press('End');await widget.getByRole('textbox',{name:/Why/}).fill('My new explanation.');release();
 await expect(widget.getByRole('status')).toContainText('thumb is saved');await expect(widget.getByRole('slider')).toHaveValue('5');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('My new explanation.');await expect(widget.getByRole('button',{name:'Disagree',exact:true})).toHaveAttribute('aria-pressed','true');await widget.getByRole('button',{name:'Save details',exact:true}).click();await expect(widget.getByRole('status')).toContainText('public response is saved');expect(posts[1]).toMatchObject({rating:5,comment:'My new explanation.'});
});
test('public feedback shows totals and the slider denominator while escaping comments',async({page},info)=>{
 await mockFeedback(page);const first={id:'first',agreement:'disagree',rating:4,modelRating:2,comment:'<img src=x onerror="alert(1)"> Unusual drive.',updatedAt:'2026-09-23T12:00:00Z',revisionId:'first',revisionNumber:1,rulesVersion:'game-suspicion-v2',public:true},second={...first,id:'second',agreement:'agree',rating:null,comment:'My explanation without a slider rating.',revisionNumber:2};
 const summary={total:2,agree:1,disagree:1,ratingCount:1,averageRating:4,ratings:[]};await page.route('**/api/games/'+gameId+'/feedback/public?*',route=>route.fulfill({json:new URL(route.request().url()).searchParams.has('cursor')?{entries:[first,second],nextCursor:null,summary}:{entries:[first],nextCursor:'next-page',summary}}));
 await page.goto(gameUrl());const list=page.locator('#fan-feedback');await expect(list.locator('article')).toHaveCount(1,{timeout:20000});await expect(list.locator('.public-feedback-summary')).toContainText('4.0 / 5');await expect(list.locator('.public-feedback-summary')).toContainText('From 1 slider rating');await expect(list.locator('.visitor-comment')).toHaveText(first.comment);await expect(list.locator('img,script')).toHaveCount(0);await expect(list.getByRole('link',{name:'Report version 1'})).toHaveAttribute('href',gameUrl()+'?revision=1');
 await list.getByRole('button',{name:'Show more feedback'}).click();await expect(list.locator('article')).toHaveCount(2);await expect(list).toContainText('No slider rating');await expect(list.locator('.visitor-comment').last()).toHaveText(second.comment);await expect(list.getByRole('button',{name:'Show more feedback'})).toHaveCount(0);await list.screenshot({path:info.outputPath('public-feedback.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('a public thumb never automatically republishes an earlier private explanation',async({page})=>{
 const posts=await mockFeedback(page,{agreement:'agree',rating:4,comment:'Private earlier explanation.',public:false});await page.goto(gameUrl());const widget=page.locator('.rating-feedback');
 await expect(widget).toContainText('earlier response is private',{timeout:20000});await expect(page.locator('#fan-feedback')).not.toContainText('Private earlier explanation.');expect(posts).toHaveLength(0);
 await widget.getByRole('button',{name:'Disagree',exact:true}).click();await expect(widget.getByRole('status')).toContainText('public response is saved');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('');await expect(widget.getByRole('slider')).toHaveAttribute('aria-valuetext','No rating selected. Move the slider to add one.');await expect(page.locator('#fan-feedback')).not.toContainText('Private earlier explanation.');expect(posts[0]).toMatchObject({action:'thumb',comment:'',rating:null});
});
test('a rejected thumb explains stale report data without claiming success',async({page})=>{
 await page.route(ownEndpoint(gameId!),route=>route.request().method()==='GET'?route.fulfill({json:{feedback:null,summary:null}}):route.fulfill({status:409,json:{error:'The rating has changed or is unavailable. Reload the report before sending feedback.'}}));await page.goto(gameUrl());const widget=page.locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await widget.getByRole('button',{name:'Agree',exact:true}).click();await expect(widget.getByRole('alert')).toContainText('Reload the report');await expect(widget.getByRole('status')).toHaveCount(0);await widget.getByRole('textbox',{name:/Why/}).fill('Keep this draft.');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Keep this draft.');
});
test('initialization and failed thumbs can retry without losing draft details',async({page})=>{
 let reads=0;await page.route(ownEndpoint(gameId!),route=>{if(route.request().method()==='GET'&&++reads>1)return route.fulfill({json:{feedback:null,summary:null}});return route.fulfill({status:502,contentType:'text/html',body:'<html>Temporary gateway error</html>'});});await page.goto(gameUrl());const widget=page.locator('.rating-feedback');
 await expect(widget.getByRole('alert')).toContainText('temporarily unavailable',{timeout:20000});await widget.getByRole('button',{name:'Disagree',exact:true}).click();await widget.getByRole('textbox',{name:/Why/}).fill('Keep my explanation.');await widget.getByRole('button',{name:'Try feedback again',exact:true}).click();await expect(widget.getByRole('button',{name:'Retry thumb',exact:true})).toBeEnabled();await expect(widget.getByRole('alert')).toContainText('temporarily unavailable');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Keep my explanation.');await expect(widget.getByRole('status')).toHaveCount(0);
});
test('public feedback distinguishes a read failure from an empty discussion',async({page})=>{
 await mockFeedback(page);let reads=0;await page.route('**/api/games/'+gameId+'/feedback/public?*',route=>++reads===1?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({json:{entries:[],nextCursor:null,summary:totals(null)}}));await page.goto(gameUrl());const list=page.locator('#fan-feedback');
 await expect(list.getByRole('alert')).toContainText('temporarily unavailable',{timeout:20000});await expect(list.locator('.feedback-empty')).toHaveCount(0);await list.getByRole('button',{name:'Try again',exact:true}).click();await expect(list.locator('.feedback-empty')).toContainText('No comments yet');await expect(list.getByRole('alert')).toHaveCount(0);await expect(list.locator('.public-feedback-summary')).toContainText('No slider ratings yet');
});
