import { test, expect } from "@playwright/test";
// Login secrets must never be retained in Playwright action traces.
test.use({trace:"off"});
test("real report exposes revision, coverage, timeline, and evidence", async ({page},testInfo) => {
  const gameId=process.env.SMOKE_GAME_ID;
  test.skip(!gameId,"Set SMOKE_GAME_ID to a real ingested game; no demo report is substituted.");
  await page.goto(`/games/${encodeURIComponent(gameId!)}`);
  await expect(page.getByRole("heading",{name:"The category record"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Win-probability timeline"})).toBeVisible();
  await expect(page.getByText("Overall percentile unavailable",{exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Revision history"})).toBeVisible();
  const evidence=page.locator("details.evidence").first();
  if(await evidence.count()) {await evidence.locator("summary").click(); await expect(evidence).toHaveAttribute("open","");}
  const archived=page.locator('.more-evidence details.evidence').first();
  if(await archived.count()) {
    const id=await archived.getAttribute('id');
    await page.goto(`/games/${encodeURIComponent(gameId!)}#${encodeURIComponent(id!)}`);
    await expect(page.locator('.more-evidence')).toHaveAttribute('open','');
    await expect(page.locator(`[id="${id}"]`)).toHaveAttribute('open','');
    await page.locator('.more-evidence > summary').click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("report.png"),fullPage:true});
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath("report-top.png")});
});
test("authenticated operator desk retains guarded forms", async ({page},testInfo) => {
  const username=process.env.SMOKE_ADMIN_USERNAME,password=process.env.SMOKE_ADMIN_PASSWORD;
  test.skip(!username || !password,"Set smoke operator credentials locally; credentials are not stored in the test source.");
  await page.goto("/admin/login");
  await page.getByLabel("Username",{exact:true}).fill(username!);
  await page.getByLabel("Password",{exact:true}).fill(password!);
  await page.getByRole("button",{name:"Sign in"}).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading",{name:"Processing queue"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Evidence review"})).toBeVisible();
  const tokens=await page.locator('form[action="/api/admin/action"] input[name="csrf"]').evaluateAll(elements=>elements.map(element=>(element as HTMLInputElement).value.length));
  expect(tokens.length).toBeGreaterThan(0); expect(tokens.every(length=>length>=32)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("operator.png"),fullPage:true});
  await page.getByRole("button",{name:"Sign out"}).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
});
