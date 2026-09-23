import { test,expect } from '@playwright/test';
const ownEndpoint=(gameId:string|undefined)=>new RegExp(`/api/games/${gameId}/feedback(?:\\?.*)?$`);
test.beforeEach(async({page})=>{await page.route('**/api/games/*/feedback/public?*',route=>route.fulfill({json:{entries:[],nextCursor:null}}));});

test('visitor feedback opens after a thumb choice, saves explicitly, and can be updated',async({page},testInfo)=>{
 test.setTimeout(60_000);
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 let saved:{agreement:string;rating:number;comment:string;public:boolean}|null=null;const submissions:Record<string,unknown>[]=[];
 // This is a UI contract test. Do not create synthetic votes in the public archive.
 await page.route(ownEndpoint(gameId),async route=>{
  const request=route.request();
  if(request.method()==='POST'){const body=request.postDataJSON();submissions.push(body);saved={agreement:body.agreement,rating:body.rating,comment:body.comment.trim(),public:body.public};}
  await route.fulfill({json:{feedback:saved,summary:saved?{total:1,agree:saved.agreement==='agree'?1:0,disagree:saved.agreement==='disagree'?1:0}:null}});
 });
 await page.route(`**/api/games/${gameId}/feedback/public?*`,route=>route.fulfill({json:{entries:saved?[{...saved,id:'our-public-feedback',revisionId:submissions.at(-1)?.revisionId,revisionNumber:1,modelRating:submissions.at(-1)?.modelRating,rulesVersion:submissions.at(-1)?.rulesVersion,updatedAt:'2026-09-23T12:00:00.000Z'}]:[],nextCursor:null}}));
 await page.goto(`/games/${gameId}`);
 const widget=page.locator('.rating-feedback');await expect(widget).toBeVisible({timeout:20000});
 await expect(widget.getByRole('slider')).toHaveCount(0);await widget.getByRole('button',{name:'Disagree',exact:true}).click();
 const slider=widget.getByRole('slider',{name:/How would you rate/});await expect(slider).toBeVisible();expect(submissions).toHaveLength(0);
 await slider.focus();await slider.press('Home');await slider.press('ArrowRight');await expect(slider).toHaveValue('2');await expect(slider).toHaveAttribute('aria-valuetext','Debatable, 2 of 5');
 await expect(widget.locator('.feedback-public-notice')).toContainText('will be public');
 await widget.getByRole('textbox',{name:/Why/}).fill('The last drive changed my view.');await widget.getByRole('button',{name:'Post feedback',exact:true}).click();
 await expect(widget.getByRole('status')).toContainText('feedback is public');expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({agreement:'disagree',rating:2,comment:'The last drive changed my view.',public:true});expect(submissions[0].revisionId).toMatch(/^[a-f0-9-]{36}$/);expect(submissions[0].rulesVersion).toMatch(/^game-suspicion-v/);
 await expect(widget).toContainText('0 agree · 1 disagree · 1 response');await widget.getByRole('textbox',{name:/Why/}).fill('After a second look, the sequence matters.');await widget.getByRole('button',{name:'Update feedback',exact:true}).click();await expect(widget.getByRole('status')).toContainText('feedback is public');expect(submissions).toHaveLength(2);
 await expect(page.locator('#fan-feedback .visitor-comment')).toHaveText('After a second look, the sequence matters.');
 await page.reload();await expect(page.locator('main .notice')).toHaveCount(0);await expect(widget.getByRole('status')).toContainText('feedback is public',{timeout:20000});await expect(widget.getByRole('button',{name:'Disagree',exact:true})).toHaveAttribute('aria-pressed','true');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('After a second look, the sequence matters.');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await widget.screenshot({path:testInfo.outputPath('feedback-saved.png')});
 const market=page.locator('.market-comparison');
 if(process.env.SMOKE_MARKET_EXPECTED==='true')await expect(market.locator('.market-numbers')).toBeVisible();
 if(await market.count())await market.screenshot({path:testInfo.outputPath('market-comparison.png')});
});

test('visitor feedback preserves the draft and explains a rejected stale revision',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 await page.route(ownEndpoint(gameId),route=>route.request().method()==='GET'?route.fulfill({json:{feedback:null,summary:null}}):route.fulfill({status:409,json:{error:'The rating has changed or is unavailable. Reload the report before sending feedback.'}}));
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget).toBeVisible({timeout:20000});await widget.getByRole('button',{name:'Agree',exact:true}).click();await widget.getByRole('textbox',{name:/Why/}).fill('Keep this explanation until it can be saved.');await widget.getByRole('button',{name:'Post feedback',exact:true}).click();
 await expect(widget.getByRole('alert')).toContainText('Reload the report');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Keep this explanation until it can be saved.');await expect(widget.getByRole('status')).toHaveCount(0);
});

test('a delayed saved response does not overwrite a new thumb choice or explanation',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route(ownEndpoint(gameId),async route=>{await gate;await route.fulfill({json:{feedback:{agreement:'agree',rating:1,comment:'An earlier view.',public:true},summary:{total:1,agree:1,disagree:0}}});});
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget).toBeVisible({timeout:20000});
 await widget.getByRole('button',{name:'Disagree',exact:true}).click();await widget.getByRole('slider').focus();await widget.getByRole('slider').press('End');await widget.getByRole('textbox',{name:/Why/}).fill('This is the new explanation.');release();
 await expect(widget.getByRole('button',{name:'Update feedback',exact:true})).toBeEnabled();
 await expect(widget.getByRole('button',{name:'Disagree',exact:true})).toHaveAttribute('aria-pressed','true');await expect(widget.getByRole('slider')).toHaveValue('5');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('This is the new explanation.');
});

test('feedback initialization can be retried and proxy errors keep the draft',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');let reads=0;
 await page.route(ownEndpoint(gameId),route=>{if(route.request().method()==='GET'&&++reads>1)return route.fulfill({json:{feedback:null,summary:null}});return route.fulfill({status:502,contentType:'text/html',body:'<html>Temporary gateway error</html>'});});
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget.getByRole('alert')).toContainText('temporarily unavailable',{timeout:20000});await widget.getByRole('button',{name:'Disagree',exact:true}).click();await widget.getByRole('textbox',{name:/Why/}).fill('Keep my explanation.');await widget.getByRole('button',{name:'Try feedback again',exact:true}).click();await expect(widget.getByRole('button',{name:'Post feedback',exact:true})).toBeEnabled();await widget.getByRole('button',{name:'Post feedback',exact:true}).click();
 await expect(widget.getByRole('alert')).toContainText('temporarily unavailable');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Keep my explanation.');await expect(widget.getByRole('status')).toHaveCount(0);
});

test('home cards start with thumbs only and initialize feedback only after interaction',async({page},testInfo)=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 let reads=0;const submissions:Record<string,unknown>[]=[];
 await page.route(ownEndpoint(gameId),route=>{const request=route.request();if(request.method()==='GET'){reads++;return route.fulfill({json:{feedback:null,summary:null}});}const body=request.postDataJSON();submissions.push(body);return route.fulfill({json:{feedback:{...body,updatedAt:'2099-09-01T22:00:00Z'},summary:{total:1,agree:1,disagree:0}}});});
 const feedbackRequests:string[]=[];page.on('request',request=>{if(/\/api\/games\/[^/]+\/feedback(?:\?|$)/.test(new URL(request.url()).pathname+new URL(request.url()).search))feedbackRequests.push(request.url());});
 await page.goto(process.env.SMOKE_SEASON?`/?season=${encodeURIComponent(process.env.SMOKE_SEASON)}`:'/');
 const card=page.locator('.game-card').filter({has:page.locator(`.scoreboard-link[href="/games/${gameId}"]`)}),widget=card.locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await expect(page.locator('main .notice')).toHaveCount(0);await page.waitForLoadState('networkidle');
 expect(feedbackRequests).toHaveLength(0);await expect(page.locator('.game-card .feedback-form')).toHaveCount(0);await expect(widget.getByRole('button')).toHaveCount(2);
 await widget.getByRole('button',{name:'Agree',exact:true}).click();await expect(widget.getByRole('slider')).toBeVisible();await expect.poll(()=>reads).toBe(1);
 await expect(widget.locator('.feedback-public-notice')).toContainText('will be public');await widget.getByRole('textbox',{name:/Why/}).fill('The rating matches what I saw.');await widget.getByRole('button',{name:'Post feedback',exact:true}).click();
 await expect(widget.getByRole('status')).toContainText('feedback is public');expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({public:true,agreement:'agree',comment:'The rating matches what I saw.'});
 await expect(widget.getByRole('link',{name:'View fan feedback'})).toHaveAttribute('href',`/games/${gameId}#fan-feedback`);expect(await card.locator('a form, form form, a button').count()).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await card.screenshot({path:testInfo.outputPath('home-feedback-expanded.png')});
});

test('public feedback displays reader ratings and report versions, escapes comments, and paginates',async({page},testInfo)=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing report.');
 await page.route(ownEndpoint(gameId),route=>route.fulfill({json:{feedback:null,summary:null}}));
 const first={id:'first',agreement:'disagree',rating:4,modelRating:2,comment:'<img src=x onerror="window.feedbackInjected=true"> That drive looked unusual.',updatedAt:'2026-09-23T12:00:00.000Z',revisionId:'first-revision',revisionNumber:1,rulesVersion:'game-suspicion-v2',public:true};
 const second={...first,id:'second',agreement:'agree',rating:2,comment:'',revisionNumber:2};
 await page.route(`**/api/games/${gameId}/feedback/public?*`,route=>route.fulfill({json:new URL(route.request().url()).searchParams.has('cursor')?{entries:[first,second],nextCursor:null}:{entries:[first],nextCursor:'next-page'}}));
 await page.goto(`/games/${gameId}`);const list=page.locator('#fan-feedback');await expect(list.locator('article')).toHaveCount(1,{timeout:20000});await expect(list).toContainText('Sus · 4/5');await expect(list).toContainText('Disagrees with Debatable');await expect(list.locator('.visitor-comment')).toHaveText(first.comment);await expect(list.locator('img,script')).toHaveCount(0);
 await expect(list.getByRole('link',{name:'Report version 1'})).toHaveAttribute('href',`/games/${gameId}?revision=1`);await list.getByRole('button',{name:'Show more feedback'}).click();await expect(list.locator('article')).toHaveCount(2);await expect(list).toContainText('Rating only');await expect(list.getByRole('button',{name:'Show more feedback'})).toHaveCount(0);
 await list.screenshot({path:testInfo.outputPath('public-feedback.png')});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('a returning visitor can change a home thumb without losing their saved rating or explanation',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const submissions:Record<string,unknown>[]=[];
 await page.route(ownEndpoint(gameId),async route=>{
  if(route.request().method()==='GET'){await gate;return route.fulfill({json:{feedback:{agreement:'agree',rating:4,comment:'The same drive had three critical flags.',public:true},summary:{total:1,agree:1,disagree:0}}});}
  const body=route.request().postDataJSON();submissions.push(body);return route.fulfill({json:{feedback:body,summary:{total:1,agree:0,disagree:1}}});
 });
 await page.goto(process.env.SMOKE_SEASON?`/?season=${encodeURIComponent(process.env.SMOKE_SEASON)}`:'/');
 const card=page.locator('.game-card').filter({has:page.locator(`.scoreboard-link[href="/games/${gameId}"]`)}),widget=card.locator('.rating-feedback');
 await expect(widget).toBeVisible({timeout:20000});await widget.getByRole('button',{name:'Disagree',exact:true}).click();await expect(widget.getByRole('slider')).toBeVisible();release();
 await expect(widget.getByRole('button',{name:'Update feedback',exact:true})).toBeEnabled();await expect(widget.getByRole('button',{name:'Disagree',exact:true})).toHaveAttribute('aria-pressed','true');await expect(widget.getByRole('slider')).toHaveValue('4');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('The same drive had three critical flags.');
 await widget.getByRole('button',{name:'Update feedback',exact:true}).click();await expect(widget.getByRole('status')).toContainText('feedback is public');expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({agreement:'disagree',rating:4,comment:'The same drive had three critical flags.',public:true});
});

test('private earlier feedback stays private until the visitor explicitly posts it',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');let posts=0;
 await page.route(ownEndpoint(gameId),route=>{if(route.request().method()==='POST')posts++;return route.fulfill({json:{feedback:{agreement:'agree',rating:1,comment:'My earlier private explanation.',public:false},summary:{total:1,agree:1,disagree:0}}});});
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget).toContainText('Your earlier response is private',{timeout:20000});await expect(widget.getByRole('button',{name:'Post feedback',exact:true})).toBeEnabled();await expect(widget.getByRole('status')).toHaveCount(0);await expect(page.locator('#fan-feedback')).not.toContainText('My earlier private explanation.');expect(posts).toBe(0);
});

test('public feedback distinguishes an error from an empty discussion and permits retry',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing report.');let reads=0;
 await page.route(ownEndpoint(gameId),route=>route.fulfill({json:{feedback:null,summary:null}}));
 await page.route(`**/api/games/${gameId}/feedback/public?*`,route=>++reads===1?route.fulfill({status:503,json:{error:'Unavailable'}}):route.fulfill({json:{entries:[],nextCursor:null}}));
 await page.goto(`/games/${gameId}`);const list=page.locator('#fan-feedback');await expect(list.getByRole('alert')).toContainText('temporarily unavailable',{timeout:20000});await expect(list.locator('.feedback-empty')).toHaveCount(0);await list.getByRole('button',{name:'Try again',exact:true}).click();await expect(list.locator('.feedback-empty')).toContainText('No public feedback yet');await expect(list.getByRole('alert')).toHaveCount(0);
});
