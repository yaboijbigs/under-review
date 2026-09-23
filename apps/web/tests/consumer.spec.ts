import { test, expect as baseExpect, type Page } from "@playwright/test";

// The shared VPS streams a loading shell before completing a server-rendered report.
// Wait for the resolved page state; a rendered data error must still fail the test.
const expect = baseExpect.configure({timeout:20_000});
const archivePath=process.env.SMOKE_SEASON?`/?season=${encodeURIComponent(process.env.SMOKE_SEASON)}`:'/';
test.setTimeout(90_000);
async function archiveReady(page:Page) {
  await expect(page.locator('#archive-title')).toBeVisible();
  await expect(page.locator('.archive-section .game-grid, .archive-section .empty-state, .archive-section .notice').first()).toBeVisible();
  await expect(page.locator('.archive-section .notice'),'The archive must resolve successfully, not to a data-connection error.').toHaveCount(0);
}
async function reportReady(page:Page) {
  await expect(page.locator('.analysis-complete, main .notice').first()).toBeVisible();
  await expect(page.locator('main .notice'),'A report data-connection error is a product failure, not a timing allowance.').toHaveCount(0);
  await expect(page.locator('.analysis-complete')).toHaveText('✓ Analysis complete');
}

test("browsing game cards does not eagerly request every report",async({page})=>{
  const prefetchedReports:string[]=[];
  page.on('request',request=>{
    const headers=request.headers(),url=new URL(request.url());
    if(url.pathname.startsWith('/games/') && (headers['next-router-prefetch']==='1' || headers.purpose==='prefetch'))prefetchedReports.push(url.pathname);
  });
  await page.goto(archivePath);
  await archiveReady(page);
  const cards=page.locator('.game-card');
  if(await cards.count()){
    await cards.first().getByRole('link').first().hover();
    await cards.last().scrollIntoViewIfNeeded();
  }
  // This check specifically observes background network requests after scrolling.
  await page.waitForLoadState('networkidle');
  expect(prefetchedReports).toEqual([]);
});

test("all weeks keeps every published report and rating filters stay honest", async ({page},testInfo)=>{
  await page.goto(archivePath);
  await archiveReady(page);
  await expect(page.getByRole("combobox",{name:"Week",exact:true})).toHaveValue("");
  const allIds=await page.locator('.game-card .scoreboard-link').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  await page.getByRole("button",{name:/Apply filters/}).click();
  await expect(page).toHaveURL(url=>url.searchParams.get('week')==='' && url.searchParams.get('result')==='');
  await archiveReady(page);
  // New completed games can legitimately be added while this live-site check runs.
  const refreshedIds=await page.locator('.game-card .scoreboard-link').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
  expect(refreshedIds).toEqual(expect.arrayContaining(allIds));
  if(allIds.length){
    await expect(page.locator('.card-verdict').first()).toBeVisible();
    await expect(page.locator('.game-card .card-top .status')).toHaveCount(0);
    await expect(page.locator('.game-card .card-bottom').first()).not.toContainText(/Not reviewed|Preliminary/i);
    await expect(page.locator('.card-rating-label').first()).toContainText('GAME RATING');
    await expect(page.locator('.card-rating-boundary')).toHaveCount(0);
  }
  await page.screenshot({path:testInfo.outputPath('consumer-home.png'),fullPage:true});
  await expect(page.getByRole('link',{name:'View source on GitHub'})).toHaveAttribute('href','https://github.com/yaboijbigs/under-review');
  const ratingFilter=page.getByRole("combobox",{name:"Rating",exact:true});
  await expect(ratingFilter.locator('option')).toHaveText(['All ratings','RIGGED? · 5/5','Sus · 4/5','Hmm · 3/5','Debatable · 2/5','Fair · 1/5','Unrated · Not enough data']);
  await ratingFilter.selectOption("sus");
  await page.getByRole("button",{name:/Apply filters/}).click();
  await expect(page).toHaveURL(url=>url.searchParams.get('result')==='sus');
  await archiveReady(page);
  const verdicts=await page.locator('.game-card').evaluateAll(cards=>cards.map(card=>card.getAttribute('data-verdict')));
  expect(verdicts.every(level=>level==='sus')).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test("the Rams filter uses the schedule team code and accepts an older link",async({page})=>{
  await page.goto('/?season=2026&team=LAR');
  await archiveReady(page);
  await expect(page.getByRole('combobox',{name:'Team',exact:true})).toHaveValue('LA');
  const cards=page.locator('.game-card');
  for(let index=0;index<await cards.count();index++)await expect(cards.nth(index)).toContainText('Los Angeles Rams');
});

test("streamed SVG final-result titles are present before hydration",async({page})=>{
  const gameId=process.env.SMOKE_OVERTIME_AWAY_GAME_ID;
  test.skip(!gameId,'Set SMOKE_OVERTIME_AWAY_GAME_ID to a real overtime report with an explicit final outcome.');
  // Inline streaming instructions still run; block external React bundles so client
  // recovery cannot conceal a server-rendered empty SVG title (React error 418).
  await page.route('**/_next/static/**/*.js',route=>route.abort());
  await page.goto(`/games/${gameId}`);
  await reportReady(page);
  const title=page.locator('.chart-observed-result > title');
  await expect(title).toHaveCount(1);
  await expect(title).toHaveText(/^Recorded final result: .+\. This point is an observation, not a forecast\.$/);
});

test("report verdict and completed automation are separate from human review",async({page},testInfo)=>{
  const gameId=process.env.SMOKE_AUDIT_GAME_ID;
  test.skip(!gameId,'Set SMOKE_AUDIT_GAME_ID to a real report.');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`/games/${gameId}`);
  await reportReady(page);
  await expect(page.locator('#verdict-title')).not.toBeEmpty();
  await expect(page.locator('.rating-scale > li')).toHaveCount(5);
  await expect(page.locator('.rating-boundary')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'How we rate games',exact:false})).toBeVisible();
  const rating=await page.locator('.game-verdict').getAttribute('data-rating');
  const selected=page.locator('.rating-scale [aria-current="step"]');
  if(rating==='unrated')await expect(selected).toHaveCount(0);
  else {await expect(selected).toHaveCount(1);await expect(selected).toHaveAttribute('data-level',rating!);await expect(page.locator('.rating-number')).toHaveAttribute('aria-label',`Level ${rating} of 5`);}
  await page.screenshot({path:testInfo.outputPath('consumer-rating.png'),fullPage:false});
  await expect(page.locator('#provenance > details')).not.toHaveAttribute('open');
  await page.getByRole('link',{name:'Data & updates',exact:true}).click();
  await expect(page.locator('#provenance > details')).toHaveAttribute('open','');
  await expect(page.getByRole('heading',{name:'Automatic analysis',exact:true})).toBeVisible();
  await expect(page.locator('.report-status-explained')).toContainText('This report was generated automatically');
  const candidate=page.locator('.review-candidate').last();
  if(await candidate.count()){
    const id=await candidate.getAttribute('id');
    await page.goto(`/games/${gameId}#${id}`);
    await reportReady(page);
    await expect(candidate).toBeVisible();
    await candidate.getByRole('link',{name:'Read the full play'}).click();
    await expect(page.locator('.source-play-archive')).toHaveAttribute('open','');
    await expect(page.locator('.source-play[open] .source-play-body')).toBeVisible();
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('consumer-play-link.png')});
});

test("published ratings keep their labels and meters consistent as data improves",async({page})=>{
  test.skip(process.env.SMOKE_CONSUMER_CASES!=='true','Use the real ingested reports named in this regression check.');
  const labels:Record<string,string>={extreme:'RIGGED?',sus:'Sus',hmm:'Hmm',debatable:'Debatable',fair:'Fair',limited:'Unrated'};
  for(const id of ['2026_02_GB_NYJ','2026_01_CLE_JAX','2026_01_TB_CIN','2026_01_NE_SEA','2026_02_IND_KC']){
    await page.goto(`/games/${id}`);
    await reportReady(page);
    const verdict=page.locator('.game-verdict'),level=await verdict.getAttribute('data-verdict'),rating=await verdict.getAttribute('data-rating');
    expect(Object.keys(labels)).toContain(level);
    await expect(page.locator('#verdict-title')).toHaveText(labels[level!]);
    const selected=verdict.locator('.rating-scale [aria-current="step"]');
    if(rating==='unrated'){await expect(selected).toHaveCount(0);await expect(verdict).toHaveAttribute('data-verdict','limited');}
    else {await expect(selected).toHaveCount(1);await expect(selected).toHaveAttribute('data-level',rating!);await expect(selected).toContainText(labels[level!]);}
  }
});

test('an awaiting game explains automatic processing without a premature rating',async({page})=>{
  const gameId=process.env.SMOKE_AWAITING_GAME_ID;
  test.skip(!gameId,'Set SMOKE_AWAITING_GAME_ID to a game that has not yet been analyzed.');
  await page.goto(`/games/${gameId}`);
  await expect(page.getByRole('heading',{name:'This game will be analyzed automatically'})).toBeVisible();
  await expect(page.getByText(/you do not need to request a review or press a button/)).toBeVisible();
  await expect(page.locator('.game-verdict')).toHaveCount(0);
});

test("momentum connects estimates and distinguishes experimental overtime from recorded results",async({page},testInfo)=>{
  const gameId=process.env.SMOKE_MOMENTUM_GAME_ID;
  test.skip(!gameId,'Set SMOKE_MOMENTUM_GAME_ID to a real overtime report.');
  await page.goto(`/games/${gameId}`);
  await reportReady(page);
  const chart=page.locator('.wp-chart');
  await chart.getByText('About this chart',{exact:true}).click();
  await expect(chart.locator('.chart-legend')).toContainText('Before-play estimates');
  await expect(chart.locator('.chart-coverage')).toContainText('model estimates');
  await expect(chart.locator('.chart-overtime-note')).toContainText('Overtime is shaded.');
  await expect(chart.locator('.chart-overtime-region rect').first()).toBeVisible();
  await expect(chart.locator('.chart-preplay-note')).toContainText('not elapsed game time');
  await expect(chart.locator('.chart-interpolation-note')).toHaveText('Line connects available values; intermediate values are not calculated.');
  await chart.locator('.chart-table > summary').click();
  const rows=chart.locator('tbody tr'),unavailable=chart.locator('.chart-estimate-unavailable');
  expect(await unavailable.count()).toBeGreaterThan(0);
  const experimental=rows.filter({hasText:'Experimental overtime'});
  const outcomes=rows.filter({hasText:'Recorded final outcome'});
  expect(await experimental.count()).toBeGreaterThan(0);
  await expect(outcomes).toHaveCount(1);
  await expect(chart.locator('.chart-observed-result')).toHaveCount(1);
  await expect(chart.locator('.chart-overtime-estimates')).toHaveCount(1);
  for(const source of await experimental.locator('td:last-child').allTextContents()) {
    const games=source.match(/(\d+) comparable prior games/);
    expect(games).not.toBeNull();expect(Number(games![1])).toBeGreaterThanOrEqual(20);
  }
  for(const row of await experimental.all()) {
    const win=Number((await row.locator('td').nth(3).innerText()).replace('%',''));
    const tie=Number((await row.locator('td').nth(4).innerText()).replace('%',''));
    expect(win).toBeGreaterThanOrEqual(0);expect(tie).toBeGreaterThanOrEqual(0);
    expect(win+tie).toBeLessThanOrEqual(100.1);
  }
  const coverage=await chart.locator('.chart-coverage').innerText();
  const match=coverage.match(/(\d+) model estimates across (\d+) recorded game entries/);
  expect(match).not.toBeNull();
  expect(await rows.count()).toBe(Number(match![2]));
  expect(await unavailable.count()).toBe(Number(match![2])-Number(match![1])-1);
  const line=await chart.locator('svg > path').first().getAttribute('d');
  expect((line?.match(/M/g)||[]).length).toBe(1);
  expect((line?.match(/L/g)||[]).length).toBe(Number(match![1]));
  const lastEstimatedIndex=await rows.evaluateAll(items=>items.reduce((last,row,index)=>row.classList.contains('chart-estimate-unavailable') ? last : index,-1));
  const finalX=Number(line!.trim().split(' ').at(-1)!.slice(1).split(',')[0]);
  expect(finalX).toBeCloseTo(44+lastEstimatedIndex/Math.max(Number(match![2])-1,1)*892,5);
  expect(finalX).toBeCloseTo(936,5);
  await experimental.first().getByRole('link').click();
  await expect(page.locator('.source-play-archive')).toHaveAttribute('open','');
  await expect(page.locator('.source-play[open] .source-play-body')).toBeVisible();
  await page.locator('#timeline').scrollIntoViewIfNeeded();
  await chart.locator('.chart-table > summary').click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await chart.screenshot({path:testInfo.outputPath('momentum-overtime.png')});
});

test("a sequence of drive-extending penalties stays grouped and inspectable",async({page},testInfo)=>{
  const gameId=process.env.SMOKE_DRIVE_SEQUENCE_GAME_ID;
  test.skip(!gameId,'Set SMOKE_DRIVE_SEQUENCE_GAME_ID to the real GB-MIN drive-sequence report.');
  await page.goto(`/games/${gameId}`);
  await reportReady(page);
  expect(Number(await page.locator('.game-verdict').getAttribute('data-rating'))).toBeGreaterThanOrEqual(4);
  await expect(page.locator('.verdict-reasons')).toContainText('3 defensive penalties extended one MIN drive on third or fourth down.');
  await expect(page.locator('.rating-play-links a')).toHaveCount(3);
  const group=page.locator('.audit-context-grid article').filter({hasText:'Drive extending penalties'});
  await expect(group).toBeVisible();
  await expect(group).toContainText('MIN received 3 first downs from GB penalties');
  await page.locator('#needs-review > details > summary').click();
  for(const playId of ['3411','3489','3592']){
    await expect(page.locator(`.rating-play-links a[href="#play-${playId}"]`)).toBeVisible();
    await expect(group.locator(`a[href="#play-${playId}"]`)).toBeVisible();
    const candidate=page.locator(`.review-candidate[data-play-id="${playId}"]`);
    await expect(candidate).toHaveCount(1);
    await expect(candidate.locator('.candidate-priority')).toHaveText('Recorded game event');
    await expect(candidate.locator('.candidate-reasons')).toContainText('review the sequence together');
  }
  await group.locator('a[href="#play-3411"]').click();
  await expect(page.locator('#play-3411')).toHaveAttribute('open','');
  await expect(page.locator('#play-3411 .source-play-body')).toBeVisible();
  await group.scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await group.screenshot({path:testInfo.outputPath('drive-extending-penalties.png')});
});
