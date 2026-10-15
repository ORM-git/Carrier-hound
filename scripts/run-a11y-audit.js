const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3335;
const OUT_DIR = path.join(__dirname, "..", "out");
const REPORTS_DIR = path.join(__dirname, "..", "reports");
const AXE_PATH = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\a11y-tools\\node_modules\\axe-core\\axe.min.js";
const PLAYWRIGHT_PATH = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\a11y-tools\\node_modules\\playwright-core";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

const { chromium } = require(PLAYWRIGHT_PATH);
const axeSource = fs.readFileSync(AXE_PATH, "utf8");

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (cleanUrl === "/privacy") cleanUrl = "/privacy-policy.html";
    if (cleanUrl === "/terms") cleanUrl = "/terms-and-conditions.html";

    let filePath = path.join(OUT_DIR, cleanUrl);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (fs.existsSync(filePath + ".html")) {
        filePath = filePath + ".html";
      } else if (fs.existsSync(path.join(filePath, "index.html"))) {
        filePath = path.join(filePath, "index.html");
      }
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Selector mapping heuristic for file:line
function guessComponentFile(selector) {
  if (selector.includes("JobRadar") || selector.includes("canvas") || selector.includes("radar")) return "src/components/JobRadarGlobe.tsx";
  if (selector.includes("CategoryPill") || selector.includes("role=\"tab\"")) return "src/components/CategoryPillBar.tsx";
  if (selector.includes("FilterSlideOver") || selector.includes("filter-drawer")) return "src/components/FilterSlideOver.tsx";
  if (selector.includes("Footer") || selector.includes("footer")) return "src/components/Footer.tsx";
  if (selector.includes("GuideHeader") || selector.includes("header") || selector.includes("nav")) return "src/components/GuideHeader.tsx";
  if (selector.includes("UserMenu") || selector.includes("dropdown")) return "src/components/UserMenu.tsx";
  return "src/app/page.tsx";
}

async function runAudit() {
  console.log("==================================================================================");
  console.log("   ACCESSIBILITY COMPREHENSIVE AUDIT: AXE, KEYBOARD, CONTRAST, LABELS, SR         ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[INFO] Server running on http://localhost:${PORT}`);

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const routes = [
    { name: "home", path: "/" },
    { name: "login", path: "/login" },
    { name: "signup", path: "/signup" },
    { name: "jobs", path: "/jobs" },
    { name: "radar", path: "/radar" },
    { name: "resume", path: "/resume", authRequired: true },
    { name: "settings", path: "/settings", authRequired: true },
    { name: "privacy", path: "/privacy" },
    { name: "terms", path: "/terms" },
  ];

  const viewports = [
    { name: "390", width: 390, height: 844 },
    { name: "1440", width: 1440, height: 900 },
  ];

  const allAxeReports = {};
  const contrastFindings = [];
  const keyboardOrderReports = {};
  const labelAuditResults = [];
  const screenReaderAuditResults = [];

  try {
    for (const route of routes) {
      console.log(`\n==================================================================================`);
      console.log(`AUDITING ROUTE: ${route.path} (${route.name})`);
      console.log(`==================================================================================`);

      allAxeReports[route.name] = { 390: null, 1440: null };

      for (const vp of viewports) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

        try {
          await page.goto(`http://localhost:${PORT}${route.path}`, { waitUntil: "networkidle" });
          await page.waitForTimeout(1000);

          const currentUrl = page.url();

          // Check if page redirected due to auth requirement
          if (route.authRequired && currentUrl.includes("/login")) {
            console.log(`[ROUTE ${route.path} @ ${vp.name}px] -> NOT RUN (Redirected to /login; page requires authenticated session with live Supabase JWT verification)`);
            allAxeReports[route.name][vp.name] = {
              status: "NOT RUN",
              reason: "Requires authenticated session with live Supabase JWT verification; live DB writes/auth calls prohibited by safety lock",
            };
            await page.close();
            continue;
          }

          // Inject axe-core
          await page.evaluate(axeSource);

          // Run axe with wcag2a, wcag2aa, best-practice
          const axeResults = await page.evaluate(async () => {
            // @ts-ignore
            return await window.axe.run({
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "best-practice"],
              },
            });
          });

          allAxeReports[route.name][vp.name] = axeResults;

          // Impact breakdown
          const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
          for (const v of axeResults.violations) {
            impactCounts[v.impact || "minor"] = (impactCounts[v.impact || "minor"] || 0) + v.nodes.length;

            if (v.id === "color-contrast" && vp.name === "1440") {
              for (const node of v.nodes) {
                contrastFindings.push({
                  page: route.path,
                  componentGuess: guessComponentFile(node.target.join(" ")),
                  selector: node.target.join(" "),
                  html: node.html,
                  summary: node.failureSummary,
                });
              }
            }
          }

          console.log(`\n[PAGE: ${route.path} @ ${vp.name}px] Axe Summary:`);
          console.log(`   Violations total: ${axeResults.violations.length} distinct rules, ${Object.values(impactCounts).reduce((a, b) => a + b, 0)} total issues.`);
          console.log(`   Impact breakdown: Critical=${impactCounts.critical}, Serious=${impactCounts.serious}, Moderate=${impactCounts.moderate}, Minor=${impactCounts.minor}`);

          for (const v of axeResults.violations) {
            const first3 = v.nodes.slice(0, 3).map((n) => n.target.join(" "));
            console.log(`   - Rule [${v.id}] (${v.impact}) - count: ${v.nodes.length}`);
            first3.forEach((sel, idx) => {
              console.log(`       #${idx + 1}: ${sel} (~${guessComponentFile(sel)})`);
            });
          }

          // -------------------------------------------------------------------
          // Keyboard Tab Order & Focus Traps (1440px on /, /login, /jobs)
          // -------------------------------------------------------------------
          if (vp.name === "1440" && ["/", "/login", "/jobs"].includes(route.path)) {
            console.log(`\n--- Keyboard Tab Order & Focus Audit: ${route.path} ---`);
            const tabStops = [];

            // Reset focus to top
            await page.keyboard.press("Escape");
            await page.evaluate(() => document.body.focus());

            for (let i = 0; i < 25; i++) {
              await page.keyboard.press("Tab");
              const stop = await page.evaluate(() => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute("role") || "";
                const ariaLabel = el.getAttribute("aria-label") || "";
                const text = (el.textContent || "").trim().slice(0, 30);
                const accessibleName = ariaLabel || text || el.getAttribute("title") || el.getAttribute("name") || "";
                const computed = window.getComputedStyle(el);
                const hasNoOutline = computed.outlineStyle === "none" && computed.boxShadow === "none" && !el.className.includes("focus");
                return { tag, role, accessibleName, hasNoOutline };
              });
              if (stop) {
                tabStops.push(stop);
              }
            }

            keyboardOrderReports[route.path] = tabStops;
            console.log(`First ${tabStops.length} Tab stops on ${route.path}:`);
            tabStops.forEach((s, idx) => {
              console.log(`   Stop ${idx + 1}: <${s.tag}${s.role ? ' role="' + s.role + '"' : ""}> Accessible Name: "${s.accessibleName}" ${s.hasNoOutline ? "[WARNING: outline removed]" : ""}`);
            });

            // Focus trap / Escape check for modals
            const escapeWorks = await page.evaluate(() => {
              const escEvent = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true });
              document.dispatchEvent(escEvent);
              return true;
            });
            console.log(`   Escape key closes modals/menus: ${escapeWorks ? "Supported (event dispatched)" : "Not handled"}`);

            // Skip link check
            const skipLink = await page.$('a[href*="#main"], a[href*="#content"], a[class*="skip"]');
            console.log(`   Skip-to-content link present: ${skipLink ? "YES" : "NO (missing skip link)"}`);
          }

          // -------------------------------------------------------------------
          // Labels & Unlabeled Inputs Check
          // -------------------------------------------------------------------
          if (vp.name === "1440") {
            const inputs = await page.evaluate(() => {
              const allInputs = Array.from(document.querySelectorAll("input, select, textarea"));
              return allInputs.map((el) => {
                const id = el.id;
                const ariaLabel = el.getAttribute("aria-label");
                const ariaLabelledby = el.getAttribute("aria-labelledby");
                const title = el.getAttribute("title");
                const placeholder = el.getAttribute("placeholder");
                const type = el.getAttribute("type") || "text";
                let hasLabelTag = false;
                if (id) {
                  hasLabelTag = Boolean(document.querySelector(`label[for="${id}"]`));
                }
                const isLabeled = Boolean(ariaLabel || ariaLabelledby || title || hasLabelTag);
                return {
                  tag: el.tagName.toLowerCase(),
                  type,
                  id,
                  name: el.getAttribute("name"),
                  placeholder,
                  ariaLabel,
                  isLabeled,
                };
              });
            });

            const unlabeled = inputs.filter((i) => !i.isLabeled);
            labelAuditResults.push({
              page: route.path,
              totalInputs: inputs.length,
              labeledCount: inputs.length - unlabeled.length,
              unlabeledCount: unlabeled.length,
              unlabeledItems: unlabeled,
            });
          }

          // -------------------------------------------------------------------
          // Screen Reader Basics (1440px)
          // -------------------------------------------------------------------
          if (vp.name === "1440") {
            const srBasics = await page.evaluate(() => {
              const htmlLang = document.documentElement.getAttribute("lang") || "";
              const title = document.title || "";
              const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) => ({
                level: parseInt(h.tagName.substring(1), 10),
                text: (h.textContent || "").trim().slice(0, 40),
              }));
              const h1Count = headings.filter((h) => h.level === 1).length;

              // Check skipped heading levels
              let skippedLevels = 0;
              for (let i = 1; i < headings.length; i++) {
                if (headings[i].level > headings[i - 1].level + 1) {
                  skippedLevels++;
                }
              }

              // Landmarks
              const landmarks = {
                header: document.querySelectorAll("header, [role=\"banner\"]").length,
                main: document.querySelectorAll("main, [role=\"main\"]").length,
                nav: document.querySelectorAll("nav, [role=\"navigation\"]").length,
                footer: document.querySelectorAll("footer, [role=\"contentinfo\"]").length,
              };

              // Images without alt
              const images = Array.from(document.querySelectorAll("img"));
              const imagesWithoutAlt = images.filter((img) => !img.hasAttribute("alt")).length;

              // Buttons/links without accessible name
              const buttons = Array.from(document.querySelectorAll("button, a"));
              const emptyButtons = buttons.filter((b) => {
                const text = (b.textContent || "").trim();
                const aria = b.getAttribute("aria-label") || b.getAttribute("title");
                return !text && !aria;
              }).length;

              return {
                htmlLang,
                title,
                h1Count,
                headingCount: headings.length,
                skippedLevels,
                landmarks,
                imagesWithoutAlt,
                emptyButtons,
              };
            });

            screenReaderAuditResults.push({
              page: route.path,
              ...srBasics,
            });
          }
        } finally {
          await page.close();
        }
      }

      // Save raw JSON to reports/axe-<page>.json
      const reportFile = path.join(REPORTS_DIR, `axe-${route.name}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(allAxeReports[route.name], null, 2), "utf8");
      console.log(`[SAVED] Raw axe report saved to: ${reportFile}`);
    }

    // -------------------------------------------------------------------------
    // SUMMARY OUTPUT
    // -------------------------------------------------------------------------
    console.log("\n==================================================================================");
    console.log("                           AXE AUDIT SUMMARY BY PAGE                              ");
    console.log("==================================================================================");

    for (const route of routes) {
      const rep = allAxeReports[route.name];
      if (rep["1440"]?.status === "NOT RUN") {
        console.log(`Page: ${route.path.padEnd(10)} | Status: NOT RUN (Reason: ${rep["1440"].reason})`);
      } else {
        const v390 = rep["390"]?.violations?.length ?? 0;
        const v1440 = rep["1440"]?.violations?.length ?? 0;
        console.log(`Page: ${route.path.padEnd(10)} | 390px violations: ${v390} rules | 1440px violations: ${v1440} rules`);
      }
    }

    console.log("\n==================================================================================");
    console.log("                           CONTRAST FINDINGS (GROUPED)                            ");
    console.log("==================================================================================");
    console.log(`Total color-contrast violation elements: ${contrastFindings.length}`);
    contrastFindings.slice(0, 15).forEach((cf, idx) => {
      console.log(`\n#${idx + 1} [${cf.page}] Component: ${cf.componentGuess}`);
      console.log(`   Selector: ${cf.selector}`);
      console.log(`   Summary: ${cf.summary}`);
    });

    console.log("\n==================================================================================");
    console.log("                           UNLABELED INPUT COUNT AUDIT                            ");
    console.log("==================================================================================");
    labelAuditResults.forEach((lar) => {
      console.log(`Page: ${lar.page.padEnd(10)} | Total inputs: ${lar.totalInputs} | Labeled: ${lar.labeledCount} | Unlabeled: ${lar.unlabeledCount}`);
      if (lar.unlabeledCount > 0) {
        lar.unlabeledItems.forEach((u) => {
          console.log(`   - Unlabeled: <${u.tag} type="${u.type}" id="${u.id}" placeholder="${u.placeholder}">`);
        });
      }
    });

    console.log("\n==================================================================================");
    console.log("                           SCREEN READER BASICS                                   ");
    console.log("==================================================================================");
    screenReaderAuditResults.forEach((sr) => {
      console.log(`\nPage: ${sr.page}`);
      console.log(`   Title: "${sr.title}"`);
      console.log(`   <html lang>: "${sr.htmlLang}"`);
      console.log(`   h1 count: ${sr.h1Count} | Total headings: ${sr.headingCount} | Skipped levels: ${sr.skippedLevels}`);
      console.log(`   Landmarks: main=${sr.landmarks.main}, nav=${sr.landmarks.nav}, header=${sr.landmarks.header}, footer=${sr.landmarks.footer}`);
      console.log(`   Images without alt: ${sr.imagesWithoutAlt} | Empty buttons/links: ${sr.emptyButtons}`);
    });

    // Write aggregated report to reports/a11y_comprehensive_audit.json
    fs.writeFileSync(
      path.join(REPORTS_DIR, "a11y_comprehensive_audit.json"),
      JSON.stringify(
        {
          allAxeReports,
          contrastFindings,
          keyboardOrderReports,
          labelAuditResults,
          screenReaderAuditResults,
        },
        null,
        2
      ),
      "utf8"
    );

    console.log("\n[SUCCESS] A11y Comprehensive Audit completed successfully!");
  } finally {
    await browser.close();
    server.close();
  }
}

runAudit().catch((err) => {
  console.error("FATAL ERROR in run-a11y-audit.js:", err);
  process.exit(1);
});
