import { test, expect } from "@playwright/test";

test("computed game audit exposes actual profiles and historical context", async ({page},testInfo) => {
  const gameId=process.env.SMOKE_AUDIT_GAME_ID;
  test.skip(!gameId,"Set SMOKE_AUDIT_GAME_ID to a real game with a computed audit.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  const audit=page.locator('#game-audit');
  await expect(audit.getByRole('heading',{name:'Game anomaly audit',exact:true})).toBeVisible();
  await expect(audit.locator('.audit-headline')).not.toBeEmpty();
  await expect(audit.locator('.profile-table')).toBeVisible();
  await expect(audit.getByRole('rowheader',{name:'Total offensive yards',exact:true})).toBeVisible();
  await expect(audit.getByRole('rowheader',{name:'Penalties',exact:true})).toBeVisible();
  await expect(audit.getByRole('rowheader',{name:'Turnover margin',exact:true})).toBeVisible();
  const flags=audit.locator('.audit-flag:visible');
  for(let index=0;index<await flags.count();index++) {
    await expect(flags.nth(index).locator('.historical-count')).toBeVisible();
    await expect(flags.nth(index).locator('.historical-coverage')).toContainText('team-games checked');
  }
  const additional=audit.locator('.additional-profile-comparisons');
  if(await additional.count()) {
    await additional.locator('summary').first().click();
    await expect(additional.locator('.audit-flag').first()).toBeVisible();
    await additional.locator('summary').first().click();
  }
  await expect(page.locator('#needs-review')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('game-audit.png'),fullPage:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath('game-audit-top.png')});
});

test("a review candidate links to its full source play without requiring a model event", async ({page},testInfo) => {
  const gameId=process.env.SMOKE_REVIEW_GAME_ID,playId=process.env.SMOKE_REVIEW_PLAY_ID;
  test.skip(!gameId||!playId,"Set real SMOKE_REVIEW_GAME_ID and SMOKE_REVIEW_PLAY_ID candidate identifiers.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  const candidate=page.locator(`.review-candidate[data-play-id="${playId}"]`);
  await expect(candidate).toBeVisible();
  await expect(candidate.locator('.candidate-reasons')).not.toBeEmpty();
  const description=await candidate.locator('.candidate-description').innerText();
  if(process.env.SMOKE_REVIEW_WITHOUT_EVENT==='true')await expect(candidate.getByRole('link',{name:'Modeled event evidence'})).toHaveCount(0);
  await candidate.getByRole('link',{name:'Open full source play'}).click();
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
  await expect(page.getByRole('heading',{name:'Game profile audit not yet computed',exact:true})).toBeVisible();
  await expect(page.locator('#game-audit .audit-status')).toHaveText('Not yet computed');
  await expect(page.locator('#needs-review')).toContainText('has not been computed');
  await expect(page.locator('.audit-flags')).toHaveCount(0);
});
