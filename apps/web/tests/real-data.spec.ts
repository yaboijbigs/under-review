import { test, expect as baseExpect, type Page } from "@playwright/test";
const expect=baseExpect.configure({timeout:20_000});
test.setTimeout(90_000);
// Login secrets must never be retained in Playwright action traces.
test.use({trace:"off"});
async function resolvedPage(page:Page,successSelector:string) {
  await expect(page.locator(`${successSelector}, main > .notice, main > .empty-state`).first()).toBeVisible();
  await expect(page.locator('main > .notice'),'A rendered data/service error must fail rather than be retried.').toHaveCount(0);
  await expect(page.getByRole('heading',{name:"The record couldn't be loaded.",exact:true})).toHaveCount(0);
  await expect(page.locator(successSelector)).toBeVisible();
}
test("real report exposes revision, coverage, timeline, and evidence", async ({page},testInfo) => {
  const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
  const gameId=process.env.SMOKE_GAME_ID;
  test.skip(!gameId,"Set SMOKE_GAME_ID to a real ingested game; no demo report is substituted.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  await resolvedPage(page,'.analysis-complete');
  await expect(page.locator('#verdict-title')).toBeVisible();
  await expect(page.locator('#needs-review > details > summary')).toContainText('Notable plays');
  await expect(page.locator('#needs-review > details')).not.toHaveAttribute('open');
  await expect(page.locator('#categories > details > summary')).toBeVisible();
  await expect(page.locator('#categories > details')).not.toHaveAttribute('open');
  expect(await page.locator('#fan-feedback').evaluate(node=>!!(node.compareDocumentPosition(document.querySelector('#needs-review')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.getByRole("heading",{name:"Game momentum"})).toBeVisible();
  await expect(page.locator('.audit-footer')).toContainText('Historical comparisons');
  await page.locator('#provenance > details > summary').click();
  await expect(page.getByRole("heading",{name:"Report updates"})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Automatic analysis',exact:true})).toBeVisible();
  await page.locator('#provenance > details > summary').click();
  await page.locator('#evidence > details > summary').click();
  const evidence=page.locator("details.evidence").first();
  if(await evidence.count()) {await evidence.locator("summary").click(); await expect(evidence).toHaveAttribute("open","");}
  const archived=page.locator('.more-evidence details.evidence').first();
  if(await archived.count()) {
    const id=await archived.getAttribute('id');
    await page.goto(`/games/${encodeURIComponent(gameId!)}#${encodeURIComponent(id!)}`);
    await resolvedPage(page,'.analysis-complete');
    await expect(page.locator('.more-evidence')).toHaveAttribute('open','');
    await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('open','');
    await page.locator('.more-evidence > summary').click();
  }
  const source=page.locator('.source-play').first();
  if(await source.count()) {
    const sourceId=await source.getAttribute('id');
    await page.goto(`/games/${encodeURIComponent(gameId!)}#${encodeURIComponent(sourceId!)}`);
    await resolvedPage(page,'.analysis-complete');
    await expect(page.locator('.source-play-archive')).toHaveAttribute('open','');
    await expect(page.locator(`[id="${sourceId}"]`)).toHaveAttribute('open','');
    await page.locator('.source-play-archive > summary').click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("report.png"),fullPage:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath("report-top.png")});
  expect(pageErrors).toEqual([]);
});
test("authenticated operator desk retains guarded forms", async ({page},testInfo) => {
  const username=process.env.SMOKE_ADMIN_USERNAME,password=process.env.SMOKE_ADMIN_PASSWORD;
  test.skip(!username || !password,"Set smoke operator credentials locally; credentials are not stored in the test source.");
  const prefetchedReports:string[]=[];
  page.on('request',request=>{
    const headers=request.headers(),url=new URL(request.url());
    if(url.pathname.startsWith('/games/') && (headers['next-router-prefetch']==='1' || headers.purpose==='prefetch'))prefetchedReports.push(url.pathname);
  });
  await page.goto("/admin/login");
  await page.getByLabel("Username",{exact:true}).fill(username!);
  await page.getByLabel("Password",{exact:true}).fill(password!);
  await page.getByRole("button",{name:"Sign in"}).click();
  await expect(page).toHaveURL(/\/admin$/);
  await resolvedPage(page,'.admin-heading');
  await expect(page.getByRole("heading",{name:"Processing queue"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Evidence review"})).toBeVisible();
  const tokens=await page.locator('form[action="/api/admin/action"] input[name="csrf"]').evaluateAll(elements=>elements.map(element=>(element as HTMLInputElement).value.length));
  expect(tokens.length).toBeGreaterThan(0); expect(tokens.every(length=>length>=32)).toBe(true);
  const draftReports=page.locator('.draft-card a[href^="/games/"]');
  if(await draftReports.count()){
    await draftReports.first().hover();
    await draftReports.last().scrollIntoViewIfNeeded();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("operator.png"),fullPage:true});
  // Observe background requests after rendering and scrolling the saved drafts.
  await page.waitForLoadState('networkidle');
  expect(prefetchedReports,'Viewing the operator desk must not prefetch all of its report links.').toEqual([]);
  await page.getByRole("button",{name:"Sign out"}).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
});
