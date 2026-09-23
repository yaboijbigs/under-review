import { test,expect } from '@playwright/test';

test('visitor feedback opens after a thumb choice, saves explicitly, and can be updated',async({page},testInfo)=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 let saved:{agreement:string;rating:number;comment:string}|null=null;const submissions:Record<string,unknown>[]=[];
 // This is a UI contract test. Do not create synthetic votes in the public archive.
 await page.route(`**/api/games/${gameId}/feedback**`,async route=>{
  const request=route.request();
  if(request.method()==='POST'){const body=request.postDataJSON();submissions.push(body);saved={agreement:body.agreement,rating:body.rating,comment:body.comment.trim()};}
  await route.fulfill({json:{feedback:saved,summary:saved?{total:1,agree:saved.agreement==='agree'?1:0,disagree:saved.agreement==='disagree'?1:0}:null}});
 });
 await page.goto(`/games/${gameId}`);
 const widget=page.locator('.rating-feedback');await expect(widget).toBeVisible({timeout:20000});
 await expect(widget.getByRole('slider')).toHaveCount(0);await widget.getByRole('button',{name:'Disagree',exact:true}).click();
 const slider=widget.getByRole('slider',{name:/How would you rate/});await expect(slider).toBeVisible();expect(submissions).toHaveLength(0);
 await slider.focus();await slider.press('Home');await slider.press('ArrowRight');await expect(slider).toHaveValue('2');await expect(slider).toHaveAttribute('aria-valuetext','Debatable, 2 of 5');
 await widget.getByRole('textbox',{name:/Why/}).fill('The last drive changed my view.');await widget.getByRole('button',{name:'Send feedback',exact:true}).click();
 await expect(widget.getByRole('status')).toContainText('feedback is saved');expect(submissions).toHaveLength(1);expect(submissions[0]).toMatchObject({agreement:'disagree',rating:2,comment:'The last drive changed my view.'});expect(submissions[0].revisionId).toMatch(/^[a-f0-9-]{36}$/);expect(submissions[0].rulesVersion).toMatch(/^game-suspicion-v/);
 await expect(widget).toContainText('0 agree · 1 disagree · 1 response');await widget.getByRole('textbox',{name:/Why/}).fill('After a second look, the sequence matters.');await widget.getByRole('button',{name:'Update feedback',exact:true}).click();await expect(widget.getByRole('status')).toContainText('feedback is saved');expect(submissions).toHaveLength(2);
 await page.reload();await expect(widget.getByRole('status')).toContainText('feedback is saved',{timeout:20000});await expect(widget.getByRole('button',{name:'Disagree',exact:true})).toHaveAttribute('aria-pressed','true');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('After a second look, the sequence matters.');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await widget.screenshot({path:testInfo.outputPath('feedback-saved.png')});
 const market=page.locator('.market-comparison');
 if(process.env.SMOKE_MARKET_EXPECTED==='true')await expect(market.locator('.market-numbers')).toBeVisible();
 if(await market.count())await market.screenshot({path:testInfo.outputPath('market-comparison.png')});
});

test('visitor feedback preserves the draft and explains a rejected stale revision',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 await page.route(`**/api/games/${gameId}/feedback**`,route=>route.request().method()==='GET'?route.fulfill({json:{feedback:null,summary:null}}):route.fulfill({status:409,json:{error:'The rating has changed or is unavailable. Reload the report before sending feedback.'}}));
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget).toBeVisible({timeout:20000});await widget.getByRole('button',{name:'Agree',exact:true}).click();await widget.getByRole('textbox',{name:/Why/}).fill('Keep this explanation until it can be saved.');await widget.getByRole('button',{name:'Send feedback',exact:true}).click();
 await expect(widget.getByRole('alert')).toContainText('Reload the report');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Keep this explanation until it can be saved.');await expect(widget.getByRole('status')).toHaveCount(0);
});

test('a delayed saved response does not overwrite a new thumb choice or explanation',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route(`**/api/games/${gameId}/feedback**`,async route=>{await gate;await route.fulfill({json:{feedback:{agreement:'agree',rating:1,comment:'An earlier view.'},summary:{total:1,agree:1,disagree:0}}});});
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget).toBeVisible({timeout:20000});
 await widget.getByRole('button',{name:'Disagree',exact:true}).click();await widget.getByRole('textbox',{name:/Why/}).fill('This is the new explanation.');release();
 await expect(widget.getByRole('button',{name:'Update feedback',exact:true})).toBeEnabled();
 await expect(widget.getByRole('button',{name:'Disagree',exact:true})).toHaveAttribute('aria-pressed','true');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('This is the new explanation.');
});

test('feedback initialization can be retried and proxy errors keep the draft',async({page})=>{
 const gameId=process.env.SMOKE_AUDIT_GAME_ID;test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to an existing rated report.');let reads=0;
 await page.route(`**/api/games/${gameId}/feedback**`,route=>{if(route.request().method()==='GET'&&++reads>1)return route.fulfill({json:{feedback:null,summary:null}});return route.fulfill({status:502,contentType:'text/html',body:'<html>Temporary gateway error</html>'});});
 await page.goto(`/games/${gameId}`);const widget=page.locator('.rating-feedback');await expect(widget.getByRole('alert')).toContainText('temporarily unavailable',{timeout:20000});await widget.getByRole('button',{name:'Disagree',exact:true}).click();await widget.getByRole('textbox',{name:/Why/}).fill('Keep my explanation.');await widget.getByRole('button',{name:'Try feedback again',exact:true}).click();await expect(widget.getByRole('button',{name:'Send feedback',exact:true})).toBeEnabled();await widget.getByRole('button',{name:'Send feedback',exact:true}).click();
 await expect(widget.getByRole('alert')).toContainText('temporarily unavailable');await expect(widget.getByRole('textbox',{name:/Why/})).toHaveValue('Keep my explanation.');await expect(widget.getByRole('status')).toHaveCount(0);
});
