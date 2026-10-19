import assert from "node:assert/strict";

// Run against a production server with real reports, after warming or deployment:
// PLAYWRIGHT_BASE_URL=http://127.0.0.1:4380 SMOKE_AUDIT_GAME_ID=2026_06_DAL_GB node apps/web/tests/isr-smoke.mjs
const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4380";
const gameId = process.env.SMOKE_AUDIT_GAME_ID;
assert.ok(gameId, "Set SMOKE_AUDIT_GAME_ID to a published game report.");

async function read(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    headers: {"Accept-Encoding": "gzip, br"},
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  return {response, html: await response.text()};
}
async function cached(path) {
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await read(path);
    assert.equal(result.response.status, 200, `${path}: HTTP status`);
    assert.equal(result.response.headers.get("content-encoding"), null, `${path}: origin compression is disabled`);
    assert.equal(result.response.headers.get("set-cookie"), null, `${path}: cached HTML contains no visitor session`);
    if (result.response.headers.get("x-nextjs-cache") === "HIT") break;
  }
  assert.equal(result.response.headers.get("x-nextjs-cache"), "HIT", `${path}: production ISR hit`);
  assert.match(result.response.headers.get("cache-control"), /s-maxage=60/, `${path}: ISR freshness`);
  return result.html;
}

const home = await cached("/");
assert.match(home, /id="archive-title"/, "Homepage renders the archive");
for (const route of ["/sources", "/methodology", "/corrections"]) await cached(route);
const gamePath = `/games/${encodeURIComponent(gameId)}`;
const game = await cached(gamePath);
assert.match(game, /class="analysis-complete"/, "Game report is complete");
const revisionNumbers = [...game.matchAll(/\?revision=(\d+)/g)].map(match => Number(match[1]));
assert.ok(revisionNumbers.length, "The report includes revision links");
const latest = Math.max(...revisionNumbers);
const revision = Number(process.env.SMOKE_OLD_REPORT_REVISION ?? Math.min(...revisionNumbers));
const historical = await cached(`${gamePath}?revision=${revision}`);
const activeLink = historical.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0];
assert.ok(activeLink?.includes(`?revision=${revision}`), "Legacy query URL selects the requested revision");
if (revision < latest) assert.match(historical, /older-revision-notice/, "Historical report is visibly distinguished");

const season = gameId.split("_")[0];
const filtered = await read(`/?season=${season}&team=LAR&result=limited`);
assert.equal(filtered.response.status, 200);
assert.match(filtered.html, /<option[^>]*value="LA"[^>]*selected/, "Legacy Rams alias still selects the Rams filter");
assert.match(filtered.html, /<option[^>]*value="limited"[^>]*selected/, "Rating query remains selected");
assert.notEqual(filtered.response.headers.get("x-nextjs-cache"), "HIT", "Filtered views are rendered for their query");
assert.match(filtered.response.headers.get("cache-control"), /no-store/, "Filtered views stay private at the HTTP layer");

for (const route of ["/api/health", `/api/games/${encodeURIComponent(gameId)}/feedback/public`]) {
  const {response} = await read(route);
  assert.equal(response.status, 200, `${route}: API available`);
  assert.match(response.headers.get("cache-control"), /no-store/, `${route}: API freshness`);
}
const admin = await read("/admin");
if (admin.response.status === 200) {
  // A loading boundary can send the shell before Next emits its login redirect.
  assert.match(admin.html, /<meta\b[^>]*id="__next-page-redirect"[^>]*http-equiv="refresh"[^>]*content="[01];url=\/admin\/login"[^>]*>/, "Streamed admin response redirects to login");
} else {
  assert.ok([303, 307].includes(admin.response.status), "Unauthenticated admin requests redirect");
  assert.match(admin.response.headers.get("location"), /\/admin\/login$/, "Admin requires authentication");
}
assert.doesNotMatch(admin.html, /AUTHENTICATED \/ OPERATOR DESK|name="csrf"/, "Unauthenticated response exposes no operator content or session token");
assert.match(admin.response.headers.get("cache-control"), /no-store/, "Admin is private at the HTTP layer");
assert.notEqual(admin.response.headers.get("x-nextjs-cache"), "HIT", "Admin is not in the shared page cache");
console.log("ISR smoke passed: public cache hits, revision selection, filters, compression, fresh APIs, and admin authentication.");
