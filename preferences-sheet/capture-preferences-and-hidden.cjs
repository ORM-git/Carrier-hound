// CONTROLLED FIXTURE capture (not live proof). Mocked signed-in session + mocked Supabase/API responses from the
// repo harness scripts/test-prompt5-base.cjs; a dummy Supabase URL; every unmocked non-localhost request is aborted.
// No real account, database or production endpoint is touched.
//
// Usage (from a checkout with node_modules, against `next dev` started with
//   NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=fixture-anon):
//   REPO=<checkout> NEXT_PUBLIC_SUPABASE_URL=https://fixtureref.supabase.co node capture-preferences-and-hidden.cjs <baseUrl> <outDir> [before]
// "before" captures only the Hidden Jobs states (main has no Preferences sheet).
const path = require("path");
const fs = require("fs");
const repo = process.env.REPO || process.cwd();
const puppeteer = require(path.join(repo, "node_modules", "puppeteer-core"));
const { CHROME_PATH, setupPageMocks, mockJobs } = require(path.join(repo, "scripts", "test-prompt5-base.cjs"));

const BASE = process.argv[2];
const OUT = process.argv[3];
const BEFORE = process.argv[4] === "before";
fs.mkdirSync(OUT, { recursive: true });

// Fixture preference row: invented values, long labels on purpose.
const PREF_ROW = {
  user_id: "usr_mock_123",
  roles: ["Frontend Developer", "Backend Engineer", "Site Reliability Engineer (SRE)", "Principal Distributed Systems Platform Engineer (Custom)"],
  categories: ["engineering", "devops"],
  experience_level: "senior",
  employment_types: ["full-time", "contract"],
  locations: ["Bengaluru, Karnataka", "Delhi NCR (Delhi, Gurugram, Noida)"],
  remote_preference: "any",
  work_models: ["hybrid", "remote"],
  date_posted: "3d",
  excluded_titles: ["Sales", "Intern", "Quality Assurance Automation Tester"],
  included_companies: [],
  excluded_companies: ["Globex Staffing Solutions International Private Limited"],
  work_auth: "I need visa sponsorship.",
  min_salary: 2500000,
  salary_currency: "INR",
  daily_digest_opt_in: true,
  onboarding_completed: true,
  eligibility_filter: true,
  country: "India",
  country_code: "IN",
  deleted_at: null,
  updated_at: "2026-11-25T08:00:00.000Z",
};
const HIDDEN_KEY = "cm_hidden_jobs_usr_mock_123";

const log = [];
const note = (s) => { log.push(s); console.log(s); };

async function newPage(browser, width, height, upsert, hiddenIds = []) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: width < 768, hasTouch: width < 768 });
  page.on("pageerror", (e) => note(`[pageerror] ${String(e).slice(0, 300)}`));
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (!url.includes("/rest/v1/user_preferences")) return;
    if (req.method() === "OPTIONS") return req.respond({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" } });
    const obj = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
    if (req.method() === "POST") {
      note(`[fixture] upsert ${upsert.mode}`);
      if (upsert.mode === "pending") return; // held: shows the Saving state
      if (upsert.mode === "fail") return req.respond({ status: 500, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ code: "XX000", message: "fixture failure" }) });
      return req.respond({ status: 201, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: "" });
    }
    req.respond({
      status: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": obj ? "application/vnd.pgrst.object+json" : "application/json" },
      body: obj ? JSON.stringify(PREF_ROW) : JSON.stringify([PREF_ROW]),
    });
  });
  // The harness must not answer user_preferences: the handler above owns it (incl. a held "pending" upsert).
  const origOn = page.on.bind(page);
  page.on = (ev, fn) => origOn(ev, ev === "request" ? (req) => { if (!req.url().includes("/rest/v1/user_preferences")) fn(req); } : fn);
  await setupPageMocks(page, { isSigned: true, isPro: true });
  page.on = origOn;
  if (hiddenIds.length) {
    await page.evaluateOnNewDocument((k, v) => localStorage.setItem(k, v), HIDDEN_KEY, JSON.stringify(hiddenIds));
  }
  return page;
}

const shot = async (page, name) => {
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  note(`[shot] ${name}.png`);
};
const clickText = async (page, selector, text) => {
  const ok = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(t) && e.offsetParent !== null);
    if (el) { el.scrollIntoView({ block: "center" }); el.click(); return true; }
    return false;
  }, selector, text);
  if (!ok) throw new Error(`not found: ${selector} "${text}"`);
};
const SHEET = '[data-testid="preferences-sheet"] [role="dialog"]';

async function openJobs(page, query = "") {
  await page.goto(`${BASE}/jobs${query}`, { waitUntil: "networkidle2", timeout: 180000 });
  await page.waitForFunction(() => document.body.innerText.includes("Recommended"), { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1500));
}

async function hiddenJobsStates(browser, w, h, prefix) {
  const hiddenId = mockJobs[0].id;
  const page = await newPage(browser, w, h, { mode: "ok" }, [hiddenId]);
  await openJobs(page, "?hidden=true");
  await new Promise((r) => setTimeout(r, 800));
  const state = await page.evaluate((hid) => ({
    url: location.pathname + location.search,
    cards: [...document.querySelectorAll("h2")].map((e) => e.textContent.trim()).filter(Boolean).length,
    hiddenOnlyEmpty: document.body.innerText.includes("No hidden positions"),
    hiddenToggleVisible: [...document.querySelectorAll('button[aria-label="Toggle Hidden Jobs"]')].some((b) => b.offsetParent !== null),
    viewingHiddenChip: [...document.querySelectorAll("span")].some((s) => s.textContent.trim() === "Viewing Hidden Jobs" && s.offsetParent !== null),
    storedHiddenIds: JSON.parse(localStorage.getItem("cm_hidden_jobs_usr_mock_123") || "[]").length,
  }), hiddenId);
  note(`[hidden ${prefix}${w}] ${JSON.stringify(state)}`);
  await shot(page, `${w}-20-hidden-url${prefix}`);
  if (w < 768) {
    await page.click('button[aria-label="Open filter settings"]');
    await page.waitForSelector('[role="dialog"][aria-label="Filter positions"]');
    await page.evaluate(() => document.querySelector('[role="dialog"][aria-label="Filter positions"] .overflow-y-auto')?.scrollTo(0, 99999));
    const sheet = await page.evaluate(() => ({
      hiddenSwitch: Boolean(document.querySelector('[role="switch"][aria-label="View Hidden Positions"]')),
      hiddenText: document.body.innerText.includes("View Hidden Positions"),
    }));
    note(`[mobile-filter-sheet ${prefix}${w}] ${JSON.stringify(sheet)}`);
    await shot(page, `${w}-21-mobile-filter-sheet-bottom${prefix}`);
  }
  await page.close();
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: "new", args: ["--no-sandbox", "--hide-scrollbars"] });
  try {
    for (const [w, h] of [[320, 640], [390, 844], [1280, 800], [1440, 900]]) {
      await hiddenJobsStates(browser, w, h, BEFORE ? "-before" : "");
      if (BEFORE) continue;

      const upsert = { mode: "ok" };
      const page = await newPage(browser, w, h, upsert);
      await openJobs(page);
      await shot(page, `${w}-00-jobs-entry`);
      await page.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 60000 });
      await page.click('button[aria-haspopup="dialog"]');
      await page.waitForSelector(SHEET);
      await shot(page, `${w}-01-sheet-collapsed`);
      const geo = await page.evaluate((sel) => {
        const d = document.querySelector(sel).getBoundingClientRect();
        const upd = [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.trim() === "Update").getBoundingClientRect();
        const x = document.querySelector('[aria-label="Close preferences without saving"]').getBoundingClientRect();
        return { vw: innerWidth, vh: innerHeight, left: d.left, right: d.right, top: d.top, bottom: d.bottom, update: [upd.width, upd.height], close: [x.width, x.height], pageHScroll: document.documentElement.scrollWidth > innerWidth, bodyScrollLocked: document.body.style.overflow === "hidden", focus: document.activeElement?.getAttribute("aria-label") };
      }, SHEET);
      note(`[geo ${w}] ${JSON.stringify(geo)}`);

      await clickText(page, `${SHEET} h3 button`, "Basic");
      await shot(page, `${w}-02-basic-open`);
      await page.evaluate((sel) => document.querySelector(`${sel} .overflow-y-auto`).scrollTo(0, 99999), SHEET);
      await shot(page, `${w}-03-basic-scrolled`);
      await page.evaluate((sel) => document.querySelector(`${sel} .overflow-y-auto`).scrollTo(0, 0), SHEET);
      await clickText(page, `${SHEET} button`, "Frontend Developer, Backend Engineer");
      await page.waitForSelector("#pref-role-search");
      await clickText(page, `${SHEET} button[aria-expanded]`, "Software/Internet/AI");
      await shot(page, `${w}-04-role-picker`);
      await page.type("#pref-role-search", "data");
      await shot(page, `${w}-05-role-picker-search`);
      await page.keyboard.press("Escape");
      note(`[escape-in-picker ${w}] ${JSON.stringify(await page.evaluate((sel) => ({ inPicker: Boolean(document.querySelector("#pref-role-search")), focus: document.activeElement?.textContent?.slice(0, 40), open: Boolean(document.querySelector(sel)) }), SHEET))}`);

      await clickText(page, `${SHEET} h3 button`, "Compensation");
      await shot(page, `${w}-06-compensation`);
      await clickText(page, `${SHEET} h3 button`, "Interests");
      await shot(page, `${w}-07-interests`);
      await clickText(page, `${SHEET} h3 button`, "Company");
      await page.type('input[placeholder="Type a company name"]', "Globex Staffing Solutions International Private Limited");
      await page.keyboard.press("Enter");
      await clickText(page, `${SHEET} button`, "Update");
      await shot(page, `${w}-08-company-conflict-blocked`);
      note(`[conflict ${w}] ${JSON.stringify(await page.evaluate((sel) => ({ open: Boolean(document.querySelector(sel)), alert: document.querySelector(`${sel} [role=alert]`)?.textContent?.slice(0, 120) }), SHEET))}`);
      // resolve the conflict: remove it from "Only show"
      await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button[aria-label^="Remove Globex"]`)][0].click(), SHEET);

      await clickText(page, `${SHEET} h3 button`, "Compensation");
      await page.select("#pref-currency", "");
      await clickText(page, `${SHEET} button`, "Update");
      await shot(page, `${w}-09-validation`);
      await page.select("#pref-currency", "INR");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await shot(page, `${w}-10-keyboard-focus`);

      upsert.mode = "pending";
      await clickText(page, `${SHEET} button`, "Update");
      await shot(page, `${w}-11-saving`);
      await page.close();

      const up2 = { mode: "fail" };
      const p2 = await newPage(browser, w, h, up2);
      await openJobs(p2);
      await p2.waitForSelector('button[aria-haspopup="dialog"]', { timeout: 60000 });
      await p2.click('button[aria-haspopup="dialog"]');
      await p2.waitForSelector(SHEET);
      await clickText(p2, `${SHEET} button`, "Update");
      await p2.waitForFunction((sel) => document.querySelector(`${sel} [role="alert"]`), { timeout: 20000 }, SHEET);
      await shot(p2, `${w}-12-save-failed`);
      up2.mode = "ok";
      await p2.keyboard.press("Escape");
      note(`[escape-close ${w}] ${JSON.stringify(await p2.evaluate(() => ({ open: Boolean(document.querySelector('[data-testid="preferences-sheet"]')), focus: document.activeElement?.textContent?.trim().slice(0, 30) })))}`);
      await p2.close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, "capture-log.txt"), log.join("\n") + "\n");
  }
})().catch((e) => { console.error(e); process.exit(1); });
