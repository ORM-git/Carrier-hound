import puppeteer, { type Page } from "puppeteer-core";
import path from "path";
import fs from "fs";

/**
 * CONTROLLED FIXTURE capture for the CM landing daily jobs pill. Not live count verification: /api/stats
 * is intercepted with a fixed body ({ jobsToday: 1122, updatedAt: now }); every other non-localhost
 * request is aborted, so nothing reaches production.
 *
 * Per viewport it waits for fonts and the real landing preview cards, then saves:
 *   <name>.png              viewport, cookie notice as a first visit shows it
 *   <name>__no-notice.png   viewport after accepting the notice through its own button
 *   <name>__hero.png        the whole hero element (no notice)
 * and writes metrics.json (pill state/geometry, preview cards present, notice/CTA overlap).
 *
 * Env: BASE_URL (default http://localhost:3000), OUT_DIR (default docs/evidence/daily-jobs-pill),
 *      CHROME_PATH or PUPPETEER_EXECUTABLE_PATH (else a per-OS default install location).
 */

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(process.cwd(), "docs", "evidence", "daily-jobs-pill"));

function chromePath(): string {
  const fromEnv = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  const defaults: Record<string, string[]> = {
    win32: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
    darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
    linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  };
  const found = (defaults[process.platform] || []).find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found: set CHROME_PATH (or PUPPETEER_EXECUTABLE_PATH) to a Chrome/Chromium executable.");
  return found;
}

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  expectedPillVisible: boolean;
}

const VIEWPORTS: ViewportSpec[] = [
  { name: "01_mobile_320x640_short_hidden", width: 320, height: 640, expectedPillVisible: false },
  { name: "02_mobile_320x800_tall_visible", width: 320, height: 800, expectedPillVisible: true },
  { name: "03_mobile_390x844_visible", width: 390, height: 844, expectedPillVisible: true },
  { name: "04_phablet_640x900_visible", width: 640, height: 900, expectedPillVisible: true },
  { name: "05_tablet_768x1024_visible", width: 768, height: 1024, expectedPillVisible: true },
  { name: "06_desktop_1440x900_visible", width: 1440, height: 900, expectedPillVisible: true },
];

async function newFixturePage(browser: puppeteer.Browser, jobsToday: number): Promise<Page> {
  const ctx = await browser.createBrowserContext(); // fresh storage: the cookie notice shows as on a first visit
  const page = await ctx.newPage();
  // tsx/esbuild keeps function names via a __name helper that also ends up in evaluated callbacks.
  await page.evaluateOnNewDocument("globalThis.__name = (f) => f;");
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith("/api/stats")) {
      req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({ jobsToday, updatedAt: new Date().toISOString() }),
      });
    } else if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.protocol === "data:") {
      req.continue();
    } else {
      req.abort("blockedbyclient");
    }
  });
  return page;
}

async function settle(page: Page, expectPill: boolean) {
  await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 10000))]).then(() => undefined));
  await page.waitForSelector('[data-testid="landing-job-card"]', { timeout: 60000 });
  // Images in the first viewport only (lazy images below the fold never load until scrolled); bounded.
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        Array.from(document.images)
          .filter((img) => !img.complete && img.getBoundingClientRect().top < innerHeight)
          .map((img) => new Promise((r) => { img.onload = img.onerror = r; }))
      ),
      new Promise((r) => setTimeout(r, 10000)),
    ]).then(() => undefined)
  );
  if (expectPill) {
    await page.waitForFunction(() => {
      const pill = document.querySelector(".hero-inner .pill");
      return Boolean(pill && !pill.classList.contains("daily-count-pending") && pill.textContent?.includes("found today"));
    }, { timeout: 30000 });
  } else {
    // Let the stats response land, so "hidden" is the short-height rule, not a pending request.
    await page.waitForFunction(() => {
      const pill = document.querySelector(".hero-inner .pill");
      return Boolean(pill && !pill.classList.contains("daily-count-pending"));
    }, { timeout: 30000 });
  }
  await new Promise((r) => setTimeout(r, 600)); // entrance transitions
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const pill = document.querySelector(".hero-inner .pill");
    const style = pill ? getComputedStyle(pill) : null;
    const notice = document.querySelector('[aria-label="Cookie and privacy notice"]');
    // The floating "View Jobs" CTA (not inside .hero-inner); the visible one if several exist.
    const cta = Array.from(document.querySelectorAll("a, button")).find((e) => /view jobs/i.test(e.textContent || "") && (e as HTMLElement).offsetParent !== null);
    const n = rect(notice);
    const c = rect(cta || null);
    const overlap = n && c ? Math.max(0, Math.min(n.y + n.h, c.y + c.h) - Math.max(n.y, c.y)) * Math.max(0, Math.min(n.x + n.w, c.x + c.w) - Math.max(n.x, c.x)) : 0;
    return {
      pill: { text: pill?.textContent?.trim() ?? null, pending: pill?.classList.contains("daily-count-pending") ?? null, display: style?.display ?? null, visibility: style?.visibility ?? null, rect: rect(pill) },
      previewCards: document.querySelectorAll('[data-testid="landing-job-card"]').length,
      fontsStatus: document.fonts.status,
      cookieNotice: n,
      viewJobsCta: c,
      ctaCoveredByNoticePx: overlap,
      ctaCoveredFraction: c && c.w * c.h ? Number((overlap / (c.w * c.h)).toFixed(3)) : null,
      pageHorizontalScroll: document.documentElement.scrollWidth > innerWidth,
    };
  });

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const report: Record<string, unknown> = { kind: "CONTROLLED FIXTURE (intercepted /api/stats; not live data)", baseUrl: BASE_URL, capturedAt: new Date().toISOString() };
  try {
    for (const vp of VIEWPORTS) {
      const page = await newFixturePage(browser, 1122);
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });
      await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 120000 });
      await settle(page, vp.expectedPillVisible);

      const withNotice = await measure(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${vp.name}.png`) });

      const accept = await page.$('[aria-label="Accept essential cookies and close notice"]');
      if (accept) {
        await accept.click();
        await new Promise((r) => setTimeout(r, 400));
      }
      const noNotice = await measure(page);
      await page.screenshot({ path: path.join(OUT_DIR, `${vp.name}__no-notice.png`) });
      const hero = await page.evaluateHandle(() => document.querySelector(".hero-inner")?.closest("section") || document.querySelector(".hero-inner"));
      const heroEl = hero.asElement();
      if (heroEl) await (heroEl as any).screenshot({ path: path.join(OUT_DIR, `${vp.name}__hero.png`) });

      const visible = withNotice.pill.display !== "none" && withNotice.pill.visibility !== "hidden" && withNotice.pill.pending === false;
      if (visible !== vp.expectedPillVisible) {
        throw new Error(`${vp.name}: expected pill ${vp.expectedPillVisible ? "visible" : "hidden"}, got ${JSON.stringify(withNotice.pill)}`);
      }
      if (vp.expectedPillVisible && !withNotice.pill.text?.includes("1,122 new job records added today")) {
        throw new Error(`${vp.name}: unexpected pill text ${withNotice.pill.text}`);
      }
      if (withNotice.previewCards < 1) throw new Error(`${vp.name}: landing preview cards did not render`);
      report[vp.name] = { viewport: `${vp.width}x${vp.height}`, expectedPillVisible: vp.expectedPillVisible, withNotice, noNotice };
      console.log(`${vp.name}: pill ${visible ? "visible" : "hidden"}, cards ${withNotice.previewCards}, CTA covered by notice ${withNotice.ctaCoveredFraction}`);
      await page.browserContext().close();
    }

    // Singular grammar and true zero at 390x844.
    for (const [count, name] of [[1, "07_mobile_singular_count_1"], [0, "08_mobile_true_zero_hidden"]] as const) {
      const page = await newFixturePage(browser, count);
      await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
      await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 120000 });
      await page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 10000))]).then(() => undefined));
      await page.waitForSelector('[data-testid="landing-job-card"]', { timeout: 60000 });
      await new Promise((r) => setTimeout(r, 1500));
      const m = await measure(page);
      if (count === 1 && !m.pill.text?.includes("1 new job record added today")) throw new Error(`singular: ${m.pill.text}`);
      if (count === 0 && m.pill.pending !== true) throw new Error(`zero must stay hidden: ${JSON.stringify(m.pill)}`);
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
      report[name] = m;
      await page.browserContext().close();
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(report, null, 2) + "\n");
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
