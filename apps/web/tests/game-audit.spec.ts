import { test, expect as baseExpect, type Page } from "@playwright/test";
const expect=baseExpect.configure({timeout:20_000});
test.setTimeout(90_000);

async function reportReady(page:Page) {
  await expect(page.locator('.analysis-complete, main > .notice, main > .empty-state').first()).toBeVisible();
  await expect(page.locator('main > .notice'),'A rendered report data error must fail, not be treated as a slow stream.').toHaveCount(0);
  await expect(page.getByRole('heading',{name:"The record couldn't be loaded.",exact:true})).toHaveCount(0);
  await expect(page.locator('.analysis-complete')).toHaveText('✓ Analysis complete');
}

test("computed game audit exposes actual profiles and historical context", async ({page},testInfo) => {
  const gameId=process.env.SMOKE_AUDIT_GAME_ID;
  test.skip(!gameId,"Set SMOKE_AUDIT_GAME_ID to a real game with a computed audit.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  await reportReady(page);
  const audit=page.locator('#game-audit');
  await expect(audit.getByRole('heading',{name:'Why this result stands out—or doesn’t',exact:true})).toBeVisible();
  await expect(page.locator('#verdict-title')).not.toBeEmpty();
  await expect(page.getByText('✓ Analysis complete',{exact:true})).toBeVisible();
  await expect(page.locator('.game-verdict .verdict-summary')).not.toBeEmpty();
  await expect(audit.locator('.audit-profile .profile-table')).toBeVisible();
  await expect(audit.getByRole('rowheader',{name:'Total offensive yards',exact:true})).toBeVisible();
  await expect(audit.getByRole('rowheader',{name:'Penalties',exact:true})).toBeVisible();
  await expect(audit.getByRole('rowheader',{name:'Turnover margin',exact:true})).toBeVisible();
  const additional=audit.locator('.additional-profile-comparisons');
  if(await additional.count()) {
    await expect(additional).not.toHaveAttribute('open');
    await additional.locator('summary').first().click();
    const flags=additional.locator('.audit-flag');
    await expect(flags.first()).toBeVisible();
    for(const flag of await flags.all()) {
      await expect(flag.locator('.historical-count')).toBeVisible();
      await expect(flag.locator('.historical-coverage')).toContainText('team-games checked');
    }
    await additional.locator('summary').first().click();
  }
  await expect(page.locator('#needs-review > details > summary')).toContainText('Notable plays');
  await expect(page.locator('#needs-review > details')).not.toHaveAttribute('open');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('game-audit.png'),fullPage:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath('game-audit-top.png')});
});

test("a review candidate links to its full source play without requiring a model event", async ({page},testInfo) => {
  const gameId=process.env.SMOKE_REVIEW_GAME_ID,playId=process.env.SMOKE_REVIEW_PLAY_ID;
  test.skip(!gameId||!playId,"Set real SMOKE_REVIEW_GAME_ID and SMOKE_REVIEW_PLAY_ID candidate identifiers.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  await reportReady(page);
  await page.locator('#needs-review > details > summary').click();
  const candidate=page.locator(`.review-candidate[data-play-id="${playId}"]`);
  if(await page.locator(`.more-candidates .review-candidate[data-play-id="${playId}"]`).count())await page.locator('.more-candidates > summary').click();
  await expect(candidate).toBeVisible();
  await expect(candidate.locator('.candidate-reasons')).not.toBeEmpty();
  const description=await candidate.locator('.candidate-description').innerText();
  if(process.env.SMOKE_REVIEW_WITHOUT_EVENT==='true')await expect(candidate.getByRole('link',{name:'Inspect the calculation'})).toHaveCount(0);
  await candidate.getByRole('link',{name:'Read the full play'}).click();
  await expect(page).toHaveURL(new RegExp(`#play-${playId}$`));
  await expect(page.locator('.source-play-archive')).toHaveAttribute('open','');
  const source=page.locator(`[id="play-${playId}"]`);
  await expect(source).toHaveAttribute('open','');
  await expect(source.locator('.source-play-body')).toContainText(description);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('candidate-source-play.png')});
});

test("an older immutable revision does not imply a clean game audit", async ({page}) => {
  const gameId=process.env.SMOKE_OLD_REPORT_GAME_ID??process.env.SMOKE_AUDIT_GAME_ID,revision=process.env.SMOKE_OLD_REPORT_REVISION;
  test.skip(!gameId||!revision,"Set a real pre-audit SMOKE_OLD_REPORT_REVISION.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}?revision=${revision}`);
  await reportReady(page);
  await expect(page.getByRole('heading',{name:'Historical comparison not available',exact:true})).toBeVisible();
  await expect(page.locator('.game-verdict')).toHaveAttribute('data-verdict','limited');
  await page.locator('#needs-review > details > summary').click();
  await expect(page.locator('#needs-review')).toContainText('does not include');
  await expect(page.locator('.audit-flags')).toHaveCount(0);
});

test('current comparisons show expected and actual performance with bounded referee context',async({page},testInfo)=>{
  const gameId=process.env.SMOKE_AUDIT_GAME_ID;
  test.skip(!gameId||process.env.SMOKE_EXPECTATIONS!=='true','Set SMOKE_EXPECTATIONS for a report with the current expectations audit.');
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  await reportReady(page);
  const breakdown=page.locator('.rating-breakdown');
  await expect(breakdown).not.toHaveAttribute('open');
  await breakdown.locator('summary').first().click();
  await expect(breakdown.locator('.rating-factor')).toHaveCount(4);
  for(const factor of ['outcome','penalty','spread','drive'])await expect(breakdown.locator(`[data-factor="${factor}"]`)).toBeVisible();
  await expect(breakdown.locator('.rating-calculation-result')).toContainText(await page.locator('#verdict-title').innerText());
  const thresholds=breakdown.locator('.rating-thresholds');
  await thresholds.locator('summary').click();
  for(const threshold of ['20%','10%','3%'])await expect(thresholds).toContainText(threshold);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await breakdown.screenshot({path:testInfo.outputPath('rating-calculation.png')});
  await breakdown.locator('summary').first().click();
  await page.locator('#categories > details > summary').click();
  await expect(page.locator('#categories')).not.toContainText('Human review of calls');
  await page.locator('#categories > details > summary').click();
  const comparisons=page.locator('.expectations-comparison');
  await expect(comparisons).toBeVisible();
  const performance=comparisons.locator('[aria-labelledby="performance-title"]');
  await expect(performance.locator('.market-numbers > div')).toHaveCount(3);
  await expect(performance).toContainText('Expected from the box score');
  await expect(performance).toContainText('Actual final margin');
  await expect(performance).toContainText('after-game comparison, not a pregame prediction');
  const penalties=comparisons.locator('[aria-labelledby="penalty-expectations-title"]');
  for(const name of ['Actual','Expected for this matchup','League average','Team’s usual penalties','Opponent usually draws'])await expect(penalties.getByRole('rowheader',{name,exact:true})).toBeVisible();
  const referee=comparisons.locator('.referee-comparison');
  await expect(referee.getByRole('heading',{name:/^The referee:/})).toBeVisible();
  if(process.env.SMOKE_REFEREE_EXPECTED==='true'){
    await expect(referee.getByRole('rowheader',{name:'Wins–losses–ties',exact:true})).toBeVisible();
    await expect(referee.locator('details')).not.toHaveAttribute('open');
    await referee.getByText('Referee comparison details',{exact:true}).click();
    await expect(referee).toContainText('Team win records are context and do not increase the rating');
    await referee.getByText('Referee comparison details',{exact:true}).click();
    await expect(performance.locator('.market-rarity')).toContainText('comparison games');
    await expect(penalties.locator('.market-rarity')).toContainText('comparison games');
    await expect(penalties.getByRole('row',{name:/Expected for this matchup/})).not.toContainText('—');
  }
  const method=comparisons.locator('details.audit-method');
  await expect(method).not.toHaveAttribute('open');
  await method.locator('summary').click();
  await expect(method).toContainText('Baseline seasons:');
  await expect(method).toContainText('Calibration seasons:');
  await expect(method).toContainText('only seasons before that game');
  await expect(method.locator('.checksum')).toHaveText(/Reference SHA-256: [a-f0-9]{64}/);
  await method.locator('summary').click();
  await comparisons.screenshot({path:testInfo.outputPath('expected-actual-and-referee.png')});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('an immutable legacy revision keeps its saved comparison without current expectations',async({page})=>{
  const gameId=process.env.SMOKE_AUDIT_GAME_ID,revision=process.env.SMOKE_LEGACY_REPORT_REVISION;
  test.skip(!gameId||!revision,'Set SMOKE_LEGACY_REPORT_REVISION to a saved legacy audit.');
  await page.goto(`/games/${encodeURIComponent(gameId!)}?revision=${revision}`);
  await reportReady(page);
  await expect(page.locator('.rating-scale > li')).toHaveCount(5);
  await expect(page.locator('.expectations-comparison')).toHaveCount(0);
  const method=page.locator('#game-audit > details.audit-method');
  await method.locator('summary').click();
  await expect(method).toContainText('under-review-game-audit-v4');
  await expect(page.locator('.rating-feedback')).toHaveCount(0);
});
