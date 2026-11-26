// FIXTURE evidence harness for PR #797: drives the real /jobs page on a local `next dev` with every API and
// Supabase request intercepted and answered from synthetic fixtures. No backend, no production.
// usage: node repair-harness.cjs <outDir>  (FIXTURE: /api/jobs/* answered with synthetic rows shaped like the repaired routes)
const puppeteer = require(require.resolve("puppeteer-core", { paths: ["E:/careermonke/cm797-wt"] }));
const fs = require("fs");
const path = require("path");

const [outDir] = process.argv.slice(2);
const flag = "repair-fixture";
const BASE = "http://localhost:3797";
const now = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = (i, over = {}) => ({
  id: `fx-${i}`, title: `Fixture Analyst ${i}`, company: `Fixturecorp ${i}`, location: "Hartford, CT, United States",
  date: new Date(now - i * 3600_000).toISOString(), postedAt: new Date(now - i * 3600_000).toISOString(),
  salary: "$90K - $120K", category: "data", remote: false, country: "US", type: "full-time", directSource: true,
  applyUrl: `https://careers.fixture-${i}.invalid/apply`, description: "FIXTURE description.", skills: ["SQL"], ...over,
});
const userId = "00000000-0000-4000-8000-000000000001";
const fakeUser = { id: userId, aud: "authenticated", role: "authenticated", email: "fixture@example.invalid", app_metadata: {}, user_metadata: {}, created_at: new Date(now).toISOString() };
const prefsRow = { roles: ["Business Analyst"], categories: ["data"], experience_level: "entry", employment_types: ["full-time"], locations: ["United States"], remote_preference: "any", work_auth: null, min_salary: null, salary_currency: "USD", daily_digest_opt_in: false, onboarding_completed: true, eligibility_filter: null, updated_at: new Date(now - 86400_000).toISOString(), country: "United States", country_code: "US", deleted_at: null, excluded_titles: [], included_companies: [], excluded_companies: [], date_posted: null, work_models: [] };
const sub = { status: "active", plan_id: "pro_monthly", current_period_end: new Date(now + 30 * 86400_000).toISOString(), grace_period_end: null };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS" };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-first-run", "--disable-extensions"] });
  const feedRequests = [];
  const log = { flag, feedRequests, checks: {} };

  async function open(device, route = "/jobs") {
    const page = await browser.newPage();
    const phone = device === "phone";
    await page.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", async (req) => {
      const url = new URL(req.url());
      if (url.hostname === "example.invalid") {
        if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors });
        if (["POST", "PATCH"].includes(req.method())) (log.writes ||= []).push({ method: req.method(), path: url.pathname, body: req.postData() || null });
        if (url.pathname.startsWith("/auth/v1/user")) return req.respond({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(fakeUser) });
        const single = (req.headers()["accept"] || "").includes("vnd.pgrst.object");
        let rows = [];
        if (url.pathname.includes("user_preferences")) rows = [prefsRow];
        if (url.pathname.includes("subscriptions")) rows = [sub];
        return req.respond({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify(single ? rows[0] ?? null : rows) });
      }
      if (url.origin === BASE && (url.pathname === "/api/jobs/recommended" || url.pathname === "/api/jobs/search")) {
        const params = {};
        for (const k of new Set(url.searchParams.keys())) params[k] = url.searchParams.getAll(k).length > 1 ? url.searchParams.getAll(k) : url.searchParams.get(k);
        feedRequests.push({ device, path: url.pathname, params });
        const type = (url.searchParams.get("jobType") || "full-time").split(",")[0].trim();
        const wm = (url.searchParams.get("workModel") || "").split(",")[0].trim();
        const lvl = url.searchParams.get("level") || "";
        // FIXTURE: firstSeenAt as the repaired routes return it; postedAt 10 days older (must never be shown as age).
        const arrival = (k) => ({ postedAt: new Date(now - 10 * 86400_000).toISOString(), firstSeenAt: k === 0 ? new Date(now - 2 * 3600_000).toISOString() : k === 1 ? null : k === 2 ? "not-a-date" : new Date(now - (k + 1) * 26 * 3600_000).toISOString() });
        const jobs = Array.from({ length: 8 }, (_, k) => job(k + 1, { type, remote: wm === "remote", title: `${lvl.includes("entry") ? "Junior " : ""}Fixture Analyst ${k + 1}`, location: wm === "remote" ? "Remote, United States" : "Hartford, CT, United States", ...arrival(k) }));
        return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs, totalCount: jobs.length }) });
      }
      if (url.origin === BASE && url.pathname.startsWith("/api/")) return req.respond({ status: 200, contentType: "application/json", body: "{}" });
      if (url.origin !== BASE) return req.abort();
      return req.continue();
    });
    // Signed-in session for the fixture Supabase host (cookie + storage), set before any page script runs.
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const session = { access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: userId, exp, role: "authenticated", aud: "authenticated" })}.fixture`, refresh_token: "fixture", expires_at: exp, expires_in: 3600, token_type: "bearer", user: fakeUser };
    await page.goto(`${BASE}/robots.txt`).catch(() => {});
    await page.evaluate((s) => { document.cookie = `sb-example-auth-token=base64-${btoa(JSON.stringify(s))}; path=/`; localStorage.setItem("sb-example-auth-token", JSON.stringify(s)); }, session);
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.waitForSelector('[data-testid="job-card"]', { timeout: 240000 }).catch(async (e) => { await page.screenshot({ path: path.join(outDir, `debug-${device}.png`) }); fs.writeFileSync(path.join(outDir, `debug-${device}.txt`), await page.evaluate(() => document.body.innerText)); throw e; });
    await sleep(1500);
    return page;
  }
  const text = (page, s) => page.evaluate((s) => document.body.innerText.includes(s), s);
  const clickByText = (page, sel, t) => page.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(t)); if (!el) throw new Error(`no ${sel} ${t}`); el.click(); }, sel, t);
  const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${flag}-${name}.png`) });

  // Desktop 1440: Preferences row + Active strip (after one filter) both visible.
  const d = await open("desktop", "/jobs?jobType=contract");
  log.checks.desktopPreferencesBox = await text(d, "Recommended uses your saved preferences");
  await d.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "OK"); b && b.click(); });
  await sleep(500);
  log.checks.desktopActiveStripVisible = await d.evaluate(() => { const e = document.querySelector('[data-testid="active-filters-strip"]'); return !!e && getComputedStyle(e).display !== "none"; });
  await shot(d, "desktop-1440-preferences-and-active-strip");
  await clickByText(d, "button", "Preferences");
  await sleep(1000);
  await shot(d, "desktop-1440-preferences-sheet");
  await d.close();

  // Phone 390: no Preferences row; Filters opens the saved-preferences sheet; Update saves to the profile.
  const p = await open("phone");
  await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "OK"); b && b.click(); });
  log.checks.phonePreferencesRow = await text(p, "Recommended uses your saved preferences");
  log.checks.phoneFiltersBadge = await p.$eval('[data-testid="mobile-reference-filters"] button[aria-label="Open filter settings"]', (b) => b.innerText.replace(/\s+/g, " ").trim());
  log.checks.phoneArrivalAges = await p.$$eval('[data-testid="cm-arrival-age"]', (els) => els.filter((e) => e.getClientRects().length).slice(0, 4).map((e) => e.textContent));
  await shot(p, "phone-390-1-no-preferences-row-arrival-age");
  await p.click('button[aria-label="Open filter settings"]');
  await sleep(1200);
  log.checks.phoneFiltersOpensSavedPreferences = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.getClientRects().length && d.innerText.includes("Update saves these to your account")));
  await shot(p, "phone-390-2-filters-opens-saved-preferences");
  const before = (log.writes || []).length;
  await clickByText(p, '[role="dialog"] button', "Update");
  await sleep(2500);
  log.checks.phoneUpdateWrites = (log.writes || []).slice(before).map((w) => `${w.method} ${w.path}`);
  log.checks.phoneActiveStripVisible = await p.evaluate(() => { const e = document.querySelector('[data-testid="active-filters-strip"]'); return !!e && getComputedStyle(e).display !== "none"; });
  await shot(p, "phone-390-3-after-update");
  await p.close();

  fs.writeFileSync(path.join(outDir, `${flag}-log.json`), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log.checks, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
