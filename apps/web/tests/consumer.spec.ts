import { test, expect } from "@playwright/test";

test("all weeks keeps every published report and result filters stay honest", async ({page},testInfo)=>{
  await page.goto("/");
  await expect(page.getByRole("combobox",{name:"Week",exact:true})).toHaveValue("");
  const allIds=await page.locator('.game-card .scoreboard-link').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  await page.getByRole("button",{name:/Apply filters/}).click();
  expect(await page.locator('.game-card .scoreboard-link').evaluateAll(links=>links.map(link=>link.getAttribute('href')))).toEqual(allIds);
  if(allIds.length){
    await expect(page.locator('.card-verdict').first()).toBeVisible();
    await expect(page.locator('.game-card .card-top .status')).toHaveCount(0);
    await expect(page.locator('.game-card .card-bottom').first()).not.toContainText(/Not reviewed|Preliminary/i);
  }
  await page.screenshot({path:testInfo.outputPath('consumer-home.png'),fullPage:true});
  await page.getByRole("combobox",{name:"Result",exact:true}).selectOption("unusual");
  await page.getByRole("button",{name:/Apply filters/}).click();
  const verdicts=await page.locator('.game-card').evaluateAll(cards=>cards.map(card=>card.getAttribute('data-verdict')));
  expect(verdicts.every(level=>level==='highly_unusual'||level==='unusual')).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test("the Rams filter uses the schedule team code and accepts an older link",async({page})=>{
  await page.goto('/?season=2026&team=LAR');
  await expect(page.getByRole('combobox',{name:'Team',exact:true})).toHaveValue('LA');
  const cards=page.locator('.game-card');
  for(let index=0;index<await cards.count();index++)await expect(cards.nth(index)).toContainText('Los Angeles Rams');
});

test("report verdict and completed automation are separate from human review",async({page},testInfo)=>{
  const gameId=process.env.SMOKE_AUDIT_GAME_ID;
  test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to a real report.');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`/games/${gameId}`);
  await expect(page.locator('.analysis-complete')).toHaveText('✓ Automated analysis complete');
  await expect(page.locator('#verdict-title')).not.toBeEmpty();
  await expect(page.locator('#provenance > details')).not.toHaveAttribute('open');
  await page.getByRole('link',{name:'Data & updates',exact:true}).click();
  await expect(page.locator('#provenance > details')).toHaveAttribute('open','');
  await expect(page.getByRole('heading',{name:'Human officiating review',exact:true})).toBeVisible();
  await expect(page.locator('.report-status-explained')).toContainText('The automatic scan is complete');
  const candidate=page.locator('.review-candidate').last();
  if(await candidate.count()){
    const id=await candidate.getAttribute('id');
    await page.goto(`/games/${gameId}#${id}`);
    await expect(candidate).toBeVisible();
    await candidate.getByRole('link',{name:'Read the full play'}).click();
    await expect(page.locator('.source-play-archive')).toHaveAttribute('open','');
    await expect(page.locator('.source-play[open] .source-play-body')).toBeVisible();
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('consumer-play-link.png')});
});

test("different outcomes are not all presented as suspicious or clean",async({page})=>{
  test.skip(process.env.SMOKE_CONSUMER_CASES!=='true','Use the real local reports named in this regression check.');
  for(const item of [
    {id:'2026_02_GB_NYJ',level:'highly_unusual',title:'Highly unusual win'},
    {id:'2026_01_CLE_JAX',level:'no_flag',title:'No unusual result detected'},
    {id:'2026_01_TB_CIN',level:'limited',title:'Not enough data for a verdict'},
    {id:'2026_01_NE_SEA',level:'limited',title:'Game verdict not available yet'},
    {id:'2026_02_IND_KC',level:'key_plays',title:'Key plays flagged'},
  ]){
    await page.goto(`/games/${item.id}`);
    await expect(page.locator('.game-verdict')).toHaveAttribute('data-verdict',item.level);
    await expect(page.locator('#verdict-title')).toHaveText(item.title);
    await expect(page.locator('.analysis-complete')).toBeVisible();
  }
  await page.goto('/games/2026_02_NYG_LA');
  await expect(page.getByRole('heading',{name:'This game will be analyzed automatically'})).toBeVisible();
  await expect(page.getByText(/you do not need to request a review or press a button/)).toBeVisible();
  await expect(page.locator('.game-verdict')).toHaveCount(0);
});
