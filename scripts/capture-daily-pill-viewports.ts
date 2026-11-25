import puppeteer from "puppeteer-core";
import path from "path";
import fs from "fs";

/**
 * Portable verification and screenshot capture script for the CM landing daily jobs found pill.
 * Captures rendered viewports across standard and edge resolutions:
 * - 320x640 (short mobile: pill intentionally hidden by media query to fit hero budget)
 * - 320x800 (taller 320px mobile: pill rendered and visible)
 * - 390x844 (modern smartphone: pill rendered and visible)
 * - 640x900 (small desktop / phablet: pill rendered and visible)
 * - 768x1024 (tablet: pill rendered and visible)
 * - 1440x900 (desktop: pill rendered and visible)
 *
 * Saves portable screenshot artifacts directly into docs/evidence/daily-jobs-pill/
 * for transparent review on GitHub without machine-specific local paths.
 */

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.resolve(process.cwd(), "docs", "evidence", "daily-jobs-pill");
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  expectedPillVisible: boolean;
  notes: string;
}

const VIEWPORTS: ViewportSpec[] = [
  {
    name: "01_mobile_320x640_short_hidden",
    width: 320,
    height: 640,
    expectedPillVisible: false,
    notes: "Short-height mobile (<=660px): pill hidden by design via CSS media query to prevent vertical crowding",
  },
  {
    name: "02_mobile_320x800_tall_visible",
    width: 320,
    height: 800,
    expectedPillVisible: true,
    notes: "Taller 320px mobile: pill rendered and visible above headline with exact count",
  },
  {
    name: "03_mobile_390x844_visible",
    width: 390,
    height: 844,
    expectedPillVisible: true,
    notes: "Standard smartphone (iPhone 12/13/14): pill rendered and visible, blue mobile layout preserved",
  },
  {
    name: "04_phablet_640x900_visible",
    width: 640,
    height: 900,
    expectedPillVisible: true,
    notes: "Phablet / small desktop: pill centered above headline",
  },
  {
    name: "05_tablet_768x1024_visible",
    width: 768,
    height: 1024,
    expectedPillVisible: true,
    notes: "Tablet (iPad portrait): pill centered above headline with ample spacing",
  },
  {
    name: "06_desktop_1440x900_visible",
    width: 1440,
    height: 900,
    expectedPillVisible: true,
    notes: "Desktop 1440px: full hero presentation with exact count and centered pill",
  },
];

async function main() {
  console.log("=== CareerMonke Landing Daily Jobs Found Pill - Viewport Verification ===");
  console.log(`Connecting to: ${BASE_URL}`);
  console.log(`Output directory: ${OUT_DIR}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();

    // Intercept /api/stats to return controlled fixture data: 1,122 jobs found today
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/api/stats")) {
        console.log("  [MOCK] Intercepted /api/stats -> returning controlled fixture (jobsToday: 1122)");
        req.respond({
          status: 200,
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": "*",
            "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
          },
          body: JSON.stringify({
            jobsToday: 1122,
            updatedAt: new Date().toISOString(),
          }),
        });
      } else {
        req.continue();
      }
    });

    for (const vp of VIEWPORTS) {
      console.log(`\n--- Testing ${vp.width}x${vp.height} (${vp.name}) ---`);
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });
      await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

      if (vp.expectedPillVisible) {
        await page.waitForFunction(
          () => {
            const pill = document.querySelector(".hero-inner .pill");
            if (!pill) return false;
            const style = window.getComputedStyle(pill);
            return (
              !pill.classList.contains("daily-count-pending") &&
              pill.textContent?.includes("new jobs found today") &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          },
          { timeout: 15000 }
        );
      } else {
        // For short mobile viewports where pill is hidden by design, wait for initial hydration
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Inspect pill element geometry and computed visibility
      const metrics = await page.evaluate(() => {
        const pill = document.querySelector(".hero-inner .pill");
        if (!pill) return null;
        const style = window.getComputedStyle(pill);
        const rect = pill.getBoundingClientRect();
        let curr: HTMLElement | null = pill as HTMLElement;
        const ancestry: string[] = [];
        while (curr) {
          const s = window.getComputedStyle(curr);
          ancestry.push(`${curr.tagName}.${curr.className} [vis=${s.visibility}, disp=${s.display}]`);
          curr = curr.parentElement;
        }
        return {
          text: pill.textContent?.trim(),
          className: pill.className,
          isPending: pill.classList.contains("daily-count-pending"),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          left: rect.left,
          ancestry,
        };
      });

      console.log("  Pill metrics:", JSON.stringify(metrics, null, 2));

      const matched = await page.evaluate(() => {
        const pill = document.querySelector(".hero-inner .pill");
        if (!pill) return [];
        const matches: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          try {
            for (const rule of Array.from(sheet.cssRules || [])) {
              const r = rule as CSSStyleRule;
              if (r.selectorText && pill.matches(r.selectorText)) {
                matches.push(`${r.selectorText} { ${r.style.cssText} }`);
              }
            }
          } catch {}
        }
        return matches;
      });
      console.log("  Matched CSS rules for pill:", matched);

      if (vp.expectedPillVisible) {
        if (!metrics || metrics.display === "none" || metrics.visibility === "hidden" || metrics.isPending) {
          throw new Error(`Expected pill to be visible at ${vp.width}x${vp.height}, but got: ${JSON.stringify(metrics)}`);
        }
        if (!metrics.text?.includes("1,122 new jobs found today")) {
          throw new Error(`Expected pill text to contain '1,122 new jobs found today', got: '${metrics.text}'`);
        }
        console.log(`  PASS: Pill visible with exact text: "${metrics.text}"`);
      } else {
        if (metrics && metrics.display !== "none" && !metrics.isPending) {
          throw new Error(`Expected pill to be hidden at ${vp.width}x${vp.height}, but display is '${metrics.display}'`);
        }
        console.log(`  PASS: Pill correctly hidden (display: ${metrics?.display}) per short-height media query`);
      }

      const screenshotPath = path.join(OUT_DIR, `${vp.name}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      console.log(`  Saved screenshot: ${screenshotPath}`);
    }

    // Now test singular grammar (count = 1)
    console.log("\n--- Testing Singular Grammar (count = 1) at 390x844 ---");
    page.removeAllListeners("request");
    page.on("request", (req) => {
      if (req.url().includes("/api/stats")) {
        console.log("  [MOCK] Intercepted /api/stats -> returning singular fixture (jobsToday: 1)");
        req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jobsToday: 1,
            updatedAt: new Date().toISOString(),
          }),
        });
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => {
        const pill = document.querySelector(".hero-inner .pill");
        return pill && pill.textContent?.includes("1 new job found today");
      },
      { timeout: 10000 }
    );

    const singularText = await page.evaluate(() => {
      const pill = document.querySelector(".hero-inner .pill");
      return pill?.textContent?.trim();
    });
    console.log(`  PASS: Singular grammar confirmed: "${singularText}"`);
    const singularPath = path.join(OUT_DIR, "07_mobile_singular_count_1.png");
    await page.screenshot({ path: singularPath, fullPage: false });
    console.log(`  Saved screenshot: ${singularPath}`);

    // Test true zero (count = 0) stays hidden
    console.log("\n--- Testing True Zero (count = 0) at 390x844 stays hidden ---");
    page.removeAllListeners("request");
    page.on("request", (req) => {
      if (req.url().includes("/api/stats")) {
        console.log("  [MOCK] Intercepted /api/stats -> returning true zero fixture (jobsToday: 0)");
        req.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jobsToday: 0,
            updatedAt: new Date().toISOString(),
          }),
        });
      } else {
        req.continue();
      }
    });

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await new Promise((r) => setTimeout(r, 1000));
    const zeroMetrics = await page.evaluate(() => {
      const pill = document.querySelector(".hero-inner .pill");
      return {
        isPending: pill?.classList.contains("daily-count-pending"),
        text: pill?.textContent?.trim(),
      };
    });
    if (!zeroMetrics.isPending) {
      throw new Error(`Expected zero count to stay pending/hidden, got: ${JSON.stringify(zeroMetrics)}`);
    }
    console.log("  PASS: True zero count stays hidden with .daily-count-pending class");

    console.log("\n=== All Viewport and Behavioral Verifications Passed Successfully ===");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
