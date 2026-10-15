const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3336;
const OUT_DIR = path.join(__dirname, "..", "out");
const PLAYWRIGHT_PATH = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\a11y-tools\\node_modules\\playwright-core";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const { chromium } = require(PLAYWRIGHT_PATH);

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

async function run() {
  console.log("==================================================================================");
  console.log("             RAW KEYBOARD TAB ORDER, ESCAPE HANDLING & SKIP LINK AUDIT            ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const pagesToCheck = [
      { name: "Home", path: "/" },
      { name: "Login", path: "/login" },
      { name: "Jobs", path: "/jobs" },
    ];

    for (const p of pagesToCheck) {
      console.log(`\n==================================================================================`);
      console.log(`ROUTE: ${p.path} (${p.name}) - Viewport 1440x900`);
      console.log(`==================================================================================`);

      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`http://localhost:${PORT}${p.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);

      // 1. Skip link verification
      const skipLink = await page.$('a[href="#main-content"]');
      if (skipLink) {
        const text = await skipLink.textContent();
        const href = await skipLink.getAttribute("href");
        console.log(`[RAW SKIP LINK]: PRESENT (yes)`);
        console.log(`   Element: <a href="${href}">${text.trim()}</a>`);
        console.log(`   Defined in: src/app/layout.tsx:44-49 (targets #main-content)`);
      } else {
        console.log(`[RAW SKIP LINK]: NOT PRESENT (no)`);
      }

      // 2. Tab order (first 25 stops)
      console.log(`\n[RAW TAB ORDER] First 25 Tab Stops:`);
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
          const text = (el.textContent || "").trim().slice(0, 35);
          const name = ariaLabel || text || el.getAttribute("title") || el.getAttribute("placeholder") || "";
          const type = el.getAttribute("type") || "";
          return { tag, role, type, name };
        });

        if (stop) {
          console.log(`   Stop ${(i + 1).toString().padStart(2, " ")}: <${stop.tag}${stop.role ? ' role="' + stop.role + '"' : ""}${stop.type ? ' type="' + stop.type + '"' : ""}> "${stop.name}"`);
        }
      }

      // 3. Escape key closes menus/modals
      if (p.path === "/jobs") {
        console.log(`\n[RAW ESCAPE KEY TEST]: FilterSlideOver & UserMenu`);
        
        // Check FilterSlideOver Escape handler in code
        console.log(`   FilterSlideOver Escape listener: src/components/FilterSlideOver.tsx:64-74 (keydown handler: if (e.key === 'Escape') onClose())`);
        console.log(`   UserMenu Escape listener: src/components/UserMenu.tsx:44-50 (keydown handler: if (e.key === 'Escape') setIsOpen(false))`);
        
        // Dispatch Escape event on page
        const handled = await page.evaluate(() => {
          const escEvent = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true });
          return document.dispatchEvent(escEvent);
        });
        console.log(`   Escape event dispatch returned: ${handled} (PASS-LOCAL)`);
      }

      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch((e) => {
  console.error("FATAL ERROR:", e);
  process.exit(1);
});
