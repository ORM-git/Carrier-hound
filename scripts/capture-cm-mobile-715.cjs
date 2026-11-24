/**
 * CM mobile PR #715 evidence harness (FIXTURE ONLY).
 *
 * Runs the real app (`next dev`) against a local fake Supabase and fixture /api responses, then drives
 * Chrome at 360x800, 390x844 and 430x932 to capture labelled screenshots and geometry measurements.
 *
 * Safety:
 * - .env.local is NOT loaded (__NEXT_PROCESSED_ENV=true) and every key it defines is blanked for the
 *   child process, so no production URL or secret reaches the dev server.
 * - NEXT_PUBLIC_SUPABASE_URL points at a local stub that refuses (and records) every write.
 * - The browser may only reach the app and the stub; every other host is aborted and recorded.
 * - /api/* is answered from fixtures in the browser, so no server route (auth, upload, finish,
 *   checkout, tracker) ever runs.
 * The run fails if any write reached the stub or any request tried to leave localhost.
 *
 * Usage: node scripts/capture-cm-mobile-715.cjs [item ...]   (items: 3 7 10 12 14 20 21 23; default all)
 * Output: reports/cm-mobile-715/<item>/*.png and reports/cm-mobile-715/ledger.json
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, execSync } = require("child_process");
const puppeteer = require("puppeteer-core");
const { stringToBase64URL } = require("@supabase/ssr/dist/main/utils");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "cm-mobile-715");
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const APP_PORT = 3715;
const STUB_PORT = 54321;
const APP = `http://localhost:${APP_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const SHA = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
const DIRTY = execSync("git status --porcelain --untracked-files=no", { cwd: ROOT }).toString().trim() ? "+wip" : "";
const WIDTHS = [
  { w: 360, h: 800 },
  { w: 390, h: 844 },
  { w: 430, h: 932 },
];

// ---------------------------------------------------------------- fixture identities (all invented)
const USERS = {
  new: { id: "00000000-0000-4000-8000-0000000000a1", email: "new.fixture@example.invalid" },
  free: { id: "00000000-0000-4000-8000-0000000000a2", email: "free.fixture@example.invalid" },
  pro: { id: "00000000-0000-4000-8000-0000000000a3", email: "pro.fixture@example.invalid" },
};
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const EXP = Math.floor(Date.now() / 1000) + 6 * 3600;
const tokenFor = (kind) =>
  `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: USERS[kind].id, email: USERS[kind].email, role: "authenticated", aud: "authenticated", exp: EXP, fixture: kind })}.fixture-signature`;
const kindByToken = (t) => Object.keys(USERS).find((k) => tokenFor(k) === t) || null;
const userJson = (kind) => ({
  id: USERS[kind].id,
  aud: "authenticated",
  role: "authenticated",
  email: USERS[kind].email,
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
});

// ---------------------------------------------------------------- fake Supabase (read-only)
const stubState = { prefs: {}, apps: {}, writes: [], hits: [] };
function startStub() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, STUB);
    stubState.hits.push(`${req.method} ${u.pathname}`);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD",
        "Access-Control-Expose-Headers": "content-range",
        ...headers,
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return send(204);
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const kind = kindByToken(bearer);

    if (u.pathname === "/auth/v1/user" && req.method === "GET") {
      return kind ? send(200, userJson(kind)) : send(401, { code: 401, msg: "FIXTURE: no session" });
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (/^\/rest\/v1\/(web_vitals|error_events|page_views)/.test(u.pathname)) {
        (stubState.telemetry ||= []).push(`${req.method} ${u.pathname}`);
        return send(403, { code: "FIXTURE", message: "FIXTURE stub refuses telemetry writes" });
      }
      stubState.writes.push(`${req.method} ${u.pathname}${u.search}`);
      return send(403, { code: "FIXTURE", message: "FIXTURE stub refuses writes" });
    }
    const m = /^\/rest\/v1\/([a-z_]+)/.exec(u.pathname);
    if (!m) return send(404, { message: "FIXTURE: unknown path" });
    const table = m[1];
    const uid = (u.searchParams.get("user_id") || "").replace(/^eq\./, "");
    const ukind = Object.keys(USERS).find((k) => USERS[k].id === uid);
    let rows = [];
    if (table === "profiles" && (ukind === "free" || ukind === "pro")) {
      rows = [{ user_id: uid, onboarding_completed_at: "2026-01-01T00:00:00Z", full_name: null, target_roles: null }];
    } else if (table === "user_preferences" && ukind && stubState.prefs[ukind]) {
      rows = [{ user_id: uid, deleted_at: null, ...stubState.prefs[ukind] }];
    } else if (table === "subscriptions" && ukind === "pro") {
      rows = [{ status: "active", plan_id: "pro_monthly", current_period_end: new Date(Date.now() + 20 * 864e5).toISOString(), grace_period_end: null }];
    } else if (table === "applications" && ukind) {
      rows = stubState.apps[ukind] || [];
    }
    const wantsObject = /vnd\.pgrst\.object/.test(req.headers.accept || "");
    if (wantsObject) {
      if (rows.length === 1) return send(200, rows[0]);
      return send(406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, message: "JSON object requested, multiple (or no) rows returned" });
    }
    return send(200, rows, { "Content-Range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` });
  });
  return new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", () => r(server)));
}

// ---------------------------------------------------------------- dev server with a scrubbed env
function scrubbedEnv(extra) {
  const env = { ...process.env };
  for (const file of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const p = path.join(ROOT, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const k = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
      if (k) env[k[1]] = "";
    }
  }
  return {
    ...env,
    __NEXT_PROCESSED_ENV: "true",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    CF_PAGES: "1", // server mode (middleware + routes), same as the Cloudflare build
    NEXT_PUBLIC_SUPABASE_URL: STUB,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon-key",
    NEXT_PUBLIC_SITE_URL: APP,
    NEXT_PUBLIC_BILLING_ENABLED: "true",
    NEXT_PUBLIC_AUTORENEW_ENABLED: "true", // Monthly shows the recurring consent (item 23); checkout itself is never called
    NEXT_PUBLIC_RAZORPAY_KEY_ID: "rzp_fixture_not_a_key",
    ...extra,
  };
}

async function waitFor(url, ms = 240000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const status = await new Promise((resolve, reject) => {
        const r = http.get(url, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        r.on("error", reject);
        r.setTimeout(60000, () => r.destroy(new Error("timeout")));
      });
      if (status && status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`server did not come up: ${url}`);
}

let devProc = null;
async function startDev(extraEnv) {
  await stopDev();
  devProc = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "dev", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: scrubbedEnv(extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logFile = fs.createWriteStream(path.join(OUT, "dev-server.log"), { flags: "a" });
  devProc.stdout.pipe(logFile);
  devProc.stderr.pipe(logFile);
  await waitFor(`${APP}/login`);
}
async function stopDev() {
  if (!devProc) return;
  const pid = devProc.pid;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    else devProc.kill("SIGTERM");
  } catch {}
  devProc = null;
  await new Promise((r) => setTimeout(r, 1500));
}

// ---------------------------------------------------------------- browser
const blocked = new Set();
const unknownApi = new Set();
let browser;
const ledger = { sha: SHA + DIRTY, generatedAt: new Date().toISOString(), items: {} };

function sessionCookies(kind) {
  const session = {
    access_token: tokenFor(kind),
    token_type: "bearer",
    expires_in: 6 * 3600,
    expires_at: EXP,
    refresh_token: `fixture-refresh-${kind}`,
    user: userJson(kind),
  };
  const value = "base64-" + stringToBase64URL(JSON.stringify(session));
  const name = "sb-127-auth-token";
  const chunks = [];
  for (let i = 0; i * 3180 < value.length; i++) chunks.push(value.slice(i * 3180, (i + 1) * 3180));
  const base = { domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" };
  return chunks.length === 1 ? [{ name, value, ...base }] : chunks.map((v, i) => ({ name: `${name}.${i}`, value: v, ...base }));
}

/**
 * New page with network guard. `api(pathname, url, req)` returns {status, body, delayMs, hang} or undefined.
 * `kind` = signed-in fixture user or null for a guest.
 */
async function newPage({ w, h, kind = null, api = () => undefined, scale = 2, consent = true }) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: scale, isMobile: true, hasTouch: true });
  await page.setUserAgent(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 CM-FIXTURE"
  );
  const client = await page.createCDPSession();
  await client.send("Network.clearBrowserCookies");
  if (kind) await page.setCookie(...sessionCookies(kind));
  // Returning visitor by default (cookie notice already acknowledged); first-visit captures pass consent:false.
  // Storage is shared across pages of this browser, so set or clear it explicitly every time.
  await page.evaluateOnNewDocument((ok) => {
    // Each fixture page starts from clean storage (the tracker merges locally cached apps).
    try { localStorage.clear(); sessionStorage.clear(); } catch {}
    if (ok) localStorage.setItem("cm_cookie_notice", JSON.stringify({ v: 1, data: true }));
    else localStorage.removeItem("cm_cookie_notice");
  }, consent);
  page.requests = [];
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const url = req.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return req.continue();
    const u = new URL(url);
    page.requests.push({ method: req.method(), url, type: req.resourceType() });
    if (u.origin === APP && u.pathname.startsWith("/api/")) {
      let r;
      try {
        r = await api(u.pathname, u, req);
      } catch (e) {
        r = { status: 500, body: { error: String(e) } };
      }
      if (r === undefined) r = defaultApi(u.pathname, u, kind);
      if (r === undefined) {
        unknownApi.add(`${req.method()} ${u.pathname}`);
        r = { status: 404, body: { error: "FIXTURE: no handler" } };
      }
      if (r.hang) return void (page.hung ||= []).push(req); // never answered: models a pending request
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
      return req.respond({ status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body ?? {}) });
    }
    if (u.origin === APP && u.pathname.startsWith("/__fixture/logo")) {
      // Sized SVG (intrinsic width) so CompanyLogo treats it as a loaded raster-like logo.
      const hue = (u.pathname.length * 47) % 360;
      return req.respond({
        status: 200,
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="hsl(${hue},70%,45%)"/><text x="32" y="41" font-size="22" text-anchor="middle" fill="#fff" font-family="Arial">FX</text></svg>`,
      });
    }
    // Browser-side Supabase auth calls (sign-in, sign-up, recover, update) are answered by the scenario.
    if (u.origin === STUB && req.method() === "OPTIONS") return req.continue();
    if (u.origin === STUB && u.pathname.startsWith("/auth/v1/") && u.pathname !== "/auth/v1/user") {
      page.authCalls = page.authCalls || [];
      page.authCalls.push(`${req.method()} ${u.pathname}${u.search}`);
      const r = (await api(u.pathname, u, req)) || { status: 400, body: { code: "fixture_unhandled", message: "FIXTURE unhandled auth call" } };
      if (r.hang) return void (page.hung ||= []).push(req);
      if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
      return req.respond({
        status: r.status || 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" },
        body: JSON.stringify(r.body ?? {}),
      });
    }
    if (u.origin === APP || u.origin === STUB) return req.continue();
    if ((u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.port === String(APP_PORT)) return req.continue();
    blocked.add(`${u.protocol}//${u.host}${u.pathname}`);
    return req.abort("blockedbyclient");
  });
  // Hung (pending) requests are aborted on close so they can never be released to a server.
  const close = page.close.bind(page);
  page.close = async () => {
    for (const r of page.hung || []) await r.abort("aborted").catch(() => {});
    return close();
  };
  return page;
}

function defaultApi(pathname, u, kind) {
  if (pathname === "/api/track" || pathname === "/api/auth/security-event" || pathname.startsWith("/api/analytics")) return { status: 204, body: {} };
  if (pathname === "/api/account/status") return { status: 200, body: { onboardingCompleted: kind === "free" || kind === "pro", deletionPending: false } };
  return undefined;
}

async function settle(page, ms = 600) {
  try {
    await page.waitForNetworkIdle({ idleTime: 400, timeout: 15000 });
  } catch {}
  await new Promise((r) => setTimeout(r, ms));
}

/** Screenshot with a FIXTURE label bar added outside the page (the page layout itself is untouched). */
async function shot(page, item, name, note = "") {
  const dir = path.join(OUT, `item${item}`);
  fs.mkdirSync(dir, { recursive: true });
  const vp = page.viewport();
  const raw = await page.screenshot({ type: "png", fullPage: false });
  const label = await browser.newPage();
  await label.setViewport({ width: vp.width, height: vp.height + 28, deviceScaleFactor: vp.deviceScaleFactor });
  await label.setContent(
    `<html><body style="margin:0;background:#111">` +
      `<div style="height:28px;display:flex;align-items:center;gap:6px;padding:0 6px;font:600 11px/1 system-ui;color:#fff;background:#B91C1C;white-space:nowrap;overflow:hidden">` +
      `FIXTURE · #${item} · ${vp.width}x${vp.height} · ${SHA}${DIRTY} · ${name}${note ? " · " + note : ""}</div>` +
      `<img style="display:block;width:${vp.width}px;height:${vp.height}px" src="data:image/png;base64,${raw.toString("base64")}"></body></html>`
  );
  const file = path.join(dir, `${name}-${vp.width}x${vp.height}.png`);
  await label.screenshot({ path: file, type: "png" });
  await label.close();
  return path.relative(OUT, file).replace(/\\/g, "/");
}

function record(item, entry) {
  (ledger.items[item] ||= []).push(entry);
  const flag = entry.pass === false ? "FAIL" : entry.pass === true ? "pass" : "info";
  console.log(`[#${item}] ${flag} ${entry.case}${entry.width ? " @" + entry.width : ""}${entry.detail ? " :: " + JSON.stringify(entry.detail) : ""}`);
}

/** Shared geometry probe run inside the page. */
const GEOMETRY = `
  window.__cm = {
    rect(sel) { const el = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }; },
    visible(el) { if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; },
    hOverflow() { return document.documentElement.scrollWidth - document.documentElement.clientWidth; },
    /** Elements whose content is cut off horizontally (text wider than its box while overflow hides it). */
    clipped(root) { const out = []; for (const el of (root || document.body).querySelectorAll('*')) { if (!window.__cm.visible(el) || el.getBoundingClientRect().width <= 1 || el.closest('.sr-only')) continue; const s = getComputedStyle(el); if ((s.overflowX === 'hidden' || s.overflow === 'hidden' || s.textOverflow === 'ellipsis') && el.scrollWidth > el.clientWidth + 1 && el.textContent.trim()) out.push({ text: el.textContent.trim().slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth }); } return out; },
    wideners() { const vw = document.documentElement.clientWidth; const out = []; for (const el of document.body.querySelectorAll('*')) { const r = el.getBoundingClientRect(); let f = el, fixed = false; while (f) { if (getComputedStyle(f).position === 'fixed') { fixed = true; break; } f = f.parentElement; } if (r.right > vw + 1 && !(fixed && Math.round(r.width) === document.documentElement.scrollWidth)) out.push({ fixed, vis: window.__cm.visible(el), h: Math.round(r.height), txt: (el.textContent||"").trim().slice(0,30), tag: el.tagName, cls: (el.className && el.className.baseVal === undefined ? String(el.className) : '').slice(0, 80), right: Math.round(r.right), w: Math.round(r.width) }); } return out.slice(0, 6); },
    hit(el) { el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; const own = (x, y) => { const t = document.elementFromPoint(x, y); return t && (t === el || el.contains(t)); }; let up = 0, down = 0, left = 0, right = 0; while (up < 40 && own(cx, cy - up - 1)) up++; while (down < 40 && own(cx, cy + down + 1)) down++; while (left < 40 && own(cx - left - 1, cy)) left++; while (right < 40 && own(cx + right + 1, cy)) right++; return { w: left + right + 1, h: up + down + 1 }; },
    overlaps(a, b) { if (!a || !b) return false; const r1 = a.getBoundingClientRect(), r2 = b.getBoundingClientRect(); return !(r1.right <= r2.left || r2.right <= r1.left || r1.bottom <= r2.top || r2.bottom <= r1.top); },
  };
`;
async function probe(page) {
  await page.evaluate(GEOMETRY);
}

module.exports = { USERS, WIDTHS, APP, STUB, SHA, OUT, newPage, settle, shot, record, probe, stubState, ledger };

// ---------------------------------------------------------------- run
async function main() {
  const want = process.argv.slice(2);
  const items = want.length ? want : ["3", "7", "10", "12", "14", "20", "21", "23"];
  fs.mkdirSync(OUT, { recursive: true });
  const ledgerPath = path.join(OUT, "ledger.json");
  if (fs.existsSync(ledgerPath)) Object.assign(ledger.items, JSON.parse(fs.readFileSync(ledgerPath, "utf8")).items || {});
  for (const i of items) ledger.items[i] = [];
  const stub = await startStub();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--disable-gpu", "--lang=en-US"] });
  const scenarios = require("./capture-cm-mobile-715.scenarios.cjs");
  let failed = false;
  try {
    const groups = { off: [], on: [] };
    for (const i of items) (scenarios.flagOn.includes(i) ? groups.on : groups.off).push(i);
    for (const [flag, list] of Object.entries(groups)) {
      if (!list.length) continue;
      await startDev({ NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED: flag === "on" ? "true" : "false" });
      for (const i of list) {
        try {
          await scenarios.run[i]({ newPage, settle, shot, record, probe, stubState, USERS, WIDTHS, APP, flag, browser });
        } catch (e) {
          failed = true;
          record(i, { case: "harness error", pass: false, detail: String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e) });
        }
      }
      // Item 7 and 10 also run with the flag OFF.
      if (flag === "on") {
        await startDev({ NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED: "false" });
        for (const i of list.filter((x) => scenarios.alsoOff.includes(x))) {
          try {
            await scenarios.run[i]({ newPage, settle, shot, record, probe, stubState, USERS, WIDTHS, APP, flag: "off", browser });
          } catch (e) {
            failed = true;
            record(i, { case: "harness error (flag off)", pass: false, detail: String(e) });
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await stopDev();
    stub.close();
  }
  ledger.guard = {
    stubWrites: stubState.writes,
    telemetryRefused: (stubState.telemetry || []).length,
    blockedOutbound: [...blocked].sort(),
    unknownApi: [...unknownApi].sort(),
  };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n");
  const fails = Object.values(ledger.items).flat().filter((e) => e.pass === false);
  console.log(`\nwrites refused by stub: ${stubState.writes.length}  blocked outbound: ${blocked.size}  unknown api: ${unknownApi.size}`);
  if (stubState.writes.length) console.log("WRITES:", stubState.writes);
  if (blocked.size) console.log("BLOCKED:", [...blocked]);
  if (unknownApi.size) console.log("UNKNOWN API:", [...unknownApi]);
  console.log(`checks failed: ${fails.length}`);
  if (failed || fails.length || stubState.writes.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    stopDev().finally(() => process.exit(1));
  });
}
