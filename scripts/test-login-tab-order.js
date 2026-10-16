const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_DIR = path.join(__dirname, "..", "out");
const PORT = 3339;

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createStaticServer(dir, port) {
  const server = http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (cleanUrl === "/login") cleanUrl = "/login.html";

    let filePath = path.join(dir, cleanUrl);
    if (!fs.existsSync(filePath) && fs.existsSync(filePath + ".html")) {
      filePath = filePath + ".html";
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

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function main() {
  console.log("==================================================================================");
  console.log("             STEP 2: FRESH KEYBOARD TAB ORDER AUDIT FOR /login                    ");
  console.log("==================================================================================\n");

  const server = await createStaticServer(OUT_DIR, PORT);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    console.log(`Navigating freshly to http://localhost:${PORT}/login (no focus hacks, no reloads)...`);
    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1500));

    // Inspect initial activeElement right after page load
    const initialElement = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        tag: el ? el.tagName.toLowerCase() : "null",
        id: el ? el.id : "",
        accessibleName: el ? (el.getAttribute("aria-label") || el.getAttribute("name") || el.textContent || "").trim().slice(0, 40) : "",
        tabIndex: el ? el.tabIndex : null,
      };
    });

    console.log(`Initial activeElement on load: <${initialElement.tag}${initialElement.id ? ' id="' + initialElement.id + '"' : ""}> Accessible Name: "${initialElement.accessibleName}" tabIndex: ${initialElement.tabIndex}\n`);

    const stops = [];

    for (let i = 1; i <= 25; i++) {
      await page.keyboard.press("Tab");
      await new Promise((r) => setTimeout(r, 100));

      const stopInfo = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) {
          return { tag: "none", accessibleName: "(no active element)", tabIndex: -1, id: "", href: "", className: "" };
        }
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        const id = el.id || "";
        const name = el.getAttribute("name") || "";
        const placeholder = el.getAttribute("placeholder") || "";
        const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
        const accessibleName = ariaLabel || name || text || placeholder || id || "(unnamed)";
        const tabIndex = el.tabIndex;
        const href = el.getAttribute("href") || "";

        return {
          tag,
          role,
          id,
          accessibleName,
          tabIndex,
          href,
          outerHtml: el.outerHTML.slice(0, 80).replace(/\n/g, " "),
        };
      });

      stops.push({ index: i, ...stopInfo });
    }

    console.log("First 25 Keyboard Tab Stops on /login:");
    console.log("------------------------------------------------------------------------------------------------------------------------");
    console.log("| #  | Tag      | Accessible Name                              | TabIndex | ID / Role / Href                          |");
    console.log("------------------------------------------------------------------------------------------------------------------------");

    for (const s of stops) {
      const idxStr = String(s.index).padStart(2);
      const tagStr = `<${s.tag}>`.padEnd(8);
      const nameStr = s.accessibleName.padEnd(44).slice(0, 44);
      const tabIdxStr = String(s.tabIndex).padStart(8);
      const extra = (s.id ? `id="${s.id}" ` : "") + (s.role ? `role="${s.role}" ` : "") + (s.href ? `href="${s.href}"` : "");
      console.log(`| ${idxStr} | ${tagStr} | ${nameStr} | ${tabIdxStr} | ${extra.slice(0, 41).padEnd(41)} |`);
    }
    console.log("------------------------------------------------------------------------------------------------------------------------\n");

  } catch (err) {
    console.error("Audit error:", err);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main();
