import { test, expect } from "@playwright/test";
test("archive is usable without fabricated results", async ({page},testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading",{name:/Beyond the final score/i})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"Season"})).toBeVisible();
  await expect(page.getByRole("combobox",{name:"Team"})).toBeVisible();
  await page.getByRole("combobox",{name:"Team"}).selectOption("SEA");
  await page.getByRole("button",{name:/Apply filters/}).click();
  await expect(page).toHaveURL(/team=SEA/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("archive.png"),fullPage:true});
});
test("methodology preserves uncertainty and report links", async ({page}) => {
  await page.goto("/methodology");
  await expect(page.getByRole("heading",{name:"Why an unusual win gets flagged"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Why a play needs review"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Why there is no rigging score"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Unavailable means unavailable"})).toBeVisible();
  await page.goto("/sources");
  await expect(page.getByRole("heading",{name:"FTN Data via nflverse"})).toBeVisible();
  await expect(page.getByRole("link",{name:"Creative Commons Attribution-ShareAlike 4.0"})).toHaveAttribute("href","https://creativecommons.org/licenses/by-sa/4.0/");
});
test("operator routes require a session", async ({page,request}) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/login/);
  await expect(page.getByLabel("Password")).toHaveAttribute("type","password");
  const response=await request.post("/api/admin/action",{form:{action:"kill-switch",enabled:"false"},maxRedirects:0});
  expect([400,401,403]).toContain(response.status());
});
test("status is inspectable and staging is excluded from indexing", async ({page,request}) => {
  await page.goto("/status");
  await expect(page.getByRole("heading",{name:"The state of the pipeline."})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Source freshness"})).toBeVisible();
  if(await page.getByText(/STAGING PREVIEW/).count()) {
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content",/noindex/);
    const robots=await request.get("/robots.txt"); expect(await robots.text()).toMatch(/Disallow: \/\s/);
    const sitemap=await request.get("/sitemap.xml"); expect(await sitemap.text()).not.toContain("<loc>");
  }
});
