// FIXTURE evidence harness for PR #797: drives the real /jobs page on a local `next dev` with every API and
// Supabase request intercepted and answered from synthetic fixtures. No backend, no production.
// usage: node harness.cjs <outDir> <flagLabel: flagoff|flagon>
const puppeteer = require(require.resolve("puppeteer-core", { paths: ["E:/careermonke/cm797-wt"] }));
const fs = require("fs");
const path = require("path");

const [outDir, flag] = process.argv.slice(2);
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

  async function open(device) {
    const page = await browser.newPage();
    const phone = device === "phone";
    await page.setViewport(phone ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", async (req) => {
      const url = new URL(req.url());
      if (url.hostname === "example.invalid") {
        if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: cors });
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
        // FIRST_SEEN=1: the route also returns firstSeenAt (not the case in production yet); postedAt is 10 days older.
        const arrival = (k) => (process.env.FIRST_SEEN === "1" ? { firstSeenAt: new Date(now - (k + 1) * 45 * 60_000).toISOString(), postedAt: new Date(now - 10 * 86400_000).toISOString() } : {});
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
    await page.goto(`${BASE}/jobs`, { waitUntil: "domcontentloaded", timeout: 240000 });
    await page.waitForSelector('[data-testid="job-card"]', { timeout: 240000 }).catch(async (e) => { await page.screenshot({ path: path.join(outDir, `debug-${device}.png`) }); fs.writeFileSync(path.join(outDir, `debug-${device}.txt`), await page.evaluate(() => document.body.innerText)); throw e; });
    await sleep(1500);
    return page;
  }
  const text = (page, s) => page.evaluate((s) => document.body.innerText.includes(s), s);
  const clickByText = (page, sel, t) => page.evaluate((sel, t) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(t)); if (!el) throw new Error(`no ${sel} ${t}`); el.click(); }, sel, t);
  const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${flag}${process.env.FIRST_SEEN === "1" ? "-firstseen" : ""}-${name}.png`) });

  // Desktop 1440, signed in: Preferences entry preserved.
  const d = await open("desktop");
  log.checks.desktopPreferencesBox = await text(d, "Recommended uses your saved preferences");
  await shot(d, "desktop-1440-preferences-preserved");
  await d.close();

  // Phone 390, signed in: no Preferences entry; Filters opens the video flow.
  const p = await open("phone");
  log.checks.phonePreferencesBox = await text(p, "Recommended uses your saved preferences");
  await shot(p, "phone-390-1-feed-no-preferences");
  await p.click('button[aria-label="Open filter settings"]');
  await sleep(800);
  await shot(p, "phone-390-2-preference-sheet");
  await clickByText(p, ".cm-vf-group button", "Basic Job Criteria");
  await sleep(600);
  for (const l of ["Contract", "Remote", "Entry Level", "Past week"]) await clickByText(p, ".cm-vf-root label", l);
  if (flag === "flagon") {
    for (const [label, v] of [["Add Excluded title", "Senior"], ["Add Excluded title", "Director"]]) {
      await p.type(`input[aria-label="${label}"]`, v);
      await p.keyboard.press("Enter");
    }
  }
  await sleep(400);
  await shot(p, "phone-390-3-basic-criteria-edited");
  if (flag === "flagon") {
    await clickByText(p, ".cm-vf-group button", "Company Insights");
    await sleep(600);
    await p.type('input[aria-label="Add Include company"]', "Acme, Inc.");
    await p.keyboard.press("Enter");
    await p.type('input[aria-label="Add Exclude company"]', "Initech");
    await p.keyboard.press("Enter");
    await sleep(400);
    await shot(p, "phone-390-4-company-lists");
  } else {
    await clickByText(p, ".cm-vf-group button", "Company Insights");
    await sleep(600);
    await shot(p, "phone-390-4-company-gated-note");
  }
  const before = feedRequests.length;
  await clickByText(p, ".cm-vf-update", "Update");
  await p.waitForFunction((n) => true, {}, before);
  await sleep(2500);
  log.afterUpdate = feedRequests.slice(before);
  await shot(p, "phone-390-5-after-update");
  await p.close();

  fs.writeFileSync(path.join(outDir, `${flag}-log.json`), JSON.stringify(log, null, 2));
  console.log(JSON.stringify({ checks: log.checks, afterUpdate: log.afterUpdate.map((r) => r.params) }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
