import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// Run after `npm run build --workspace @under-review/web`.
// Both modes use the same production build; no database or external service is needed.
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const webRoot = path.join(projectRoot, "apps/web");
const nextCli = path.join(projectRoot, "node_modules/next/dist/bin/next");

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

async function verifyMode(staging) {
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const brand = staging ? "Runtime Stage Audit" : "Runtime Public Audit";
  const handle = staging ? "runtime_stage" : "runtime_public";
  const accent = staging ? "#eebb55" : "#bbdd44";
  const background = staging ? "#fff8ee" : "#f5f5ee";
  const ink = staging ? "#223344" : "#223322";
  const child = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: webRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      NODE_ENV: "production",
      PRIVATE_STAGING: String(staging),
      DEMO_MODE: "false",
      SITE_URL: baseUrl,
      BRAND_NAME: brand,
      BRAND_TAGLINE: "Runtime settings verified",
      BRAND_ACCENT: accent,
      BRAND_BACKGROUND: background,
      BRAND_INK: ink,
      SOCIAL_HANDLE: handle,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  let output = "";
  let spawnError;
  child.on("error", error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output = (output + data).slice(-4000); });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    const deadline = Date.now() + 25000;
    let ready = false;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Production server exited before becoming ready.\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for this child server to listen. */ }
      await delay(150);
    }
    assert.ok(ready, `Production server did not become ready.\n${output}`);
    for (const route of ["/methodology", "/sources"]) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200, `${route}: HTTP status`);
      const html = await response.text();
      assert.ok(html.match(/<title>([^<]*)<\/title>/)?.[1].includes(brand), `${route}: runtime metadata brand`);
      assert.ok(html.includes(`aria-label="${brand} home"`), `${route}: runtime body brand`);
      assert.ok(html.includes("Runtime settings verified"), `${route}: runtime tagline`);
      assert.ok(html.includes(`--accent:${accent}`), `${route}: runtime accent`);
      assert.ok(html.includes(`--paper:${background}`), `${route}: runtime background`);
      assert.ok(html.includes(`--ink:${ink}`), `${route}: runtime ink`);
      assert.ok(html.includes(`href="https://x.com/${handle}"`), `${route}: runtime social link`);
      const robotsMeta = html.match(/<meta name="robots" content="([^"]*)"/)?.[1];
      assert.equal(robotsMeta, staging ? "noindex, nofollow" : "index, follow", `${route}: runtime indexing metadata`);
      assert.equal(html.includes("STAGING PREVIEW"), staging, `${route}: staging banner`);
    }
    const robots = await (await fetch(`${baseUrl}/robots.txt`)).text();
    if (staging) {
      assert.match(robots, /^Disallow: \/$/m);
      assert.doesNotMatch(robots, /^Sitemap:/m);
    } else {
      assert.match(robots, /^Allow: \/$/m);
      assert.match(robots, /^Disallow: \/admin$/m);
      assert.doesNotMatch(robots, /^Disallow: \/$/m);
      assert.ok(robots.includes(`Sitemap: ${baseUrl}/sitemap.xml`), "Runtime site URL in public robots");
    }
    console.log(`Runtime configuration passed: ${staging ? "staging" : "public"} metadata, theme, social handle, and robots.`);
  } finally {
    if (child.exitCode === null && !spawnError) child.kill();
    await closed;
  }
}

await verifyMode(false);
await verifyMode(true);
