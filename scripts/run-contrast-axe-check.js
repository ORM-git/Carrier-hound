const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3360;
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, "..", "out");
const AXE_PATH = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\a11y-tools\\node_modules\\axe-core\\axe.min.js";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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

const PAGES = [
  { name: "landing", path: "/" },
  { name: "login", path: "/login" },
  { name: "signup", path: "/signup" },
  { name: "jobs", path: "/jobs" },
  { name: "worldwide", path: "/worldwide" },
  { name: "privacy", path: "/privacy-policy" },
  { name: "terms", path: "/terms-and-conditions" },
  { name: "radar", path: "/radar" },
];

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));
  console.log(`[INFO] Serving ${OUT_DIR} on http://localhost:${PORT}`);

  const axeSource = fs.readFileSync(AXE_PATH, "utf8");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const results = {};

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    for (const p of PAGES) {
      await page.goto(`http://localhost:${PORT}${p.path}`, { waitUntil: "networkidle0", timeout: 30000 });
      await page.evaluate(axeSource);

      const axeResults = await page.evaluate(async () => {
        return await window.axe.run({
          runOnly: {
            type: "rule",
            values: ["color-contrast", "link-in-text-block", "image-redundant-alt"],
          },
        });
      });

      const contrastViolations = axeResults.violations.find((v) => v.id === "color-contrast");
      const linkViolations = axeResults.violations.find((v) => v.id === "link-in-text-block");
      const imgViolations = axeResults.violations.find((v) => v.id === "image-redundant-alt");

      results[p.name] = {
        colorContrastNodes: contrastViolations ? contrastViolations.nodes.map((n) => ({
          html: n.html,
          target: n.target,
          failureSummary: n.failureSummary,
        })) : [],
        linkInTextBlockNodes: linkViolations ? linkViolations.nodes.map((n) => ({
          html: n.html,
          target: n.target,
          failureSummary: n.failureSummary,
        })) : [],
        imageRedundantAltNodes: imgViolations ? imgViolations.nodes.map((n) => ({
          html: n.html,
          target: n.target,
          failureSummary: n.failureSummary,
        })) : [],
      };

      console.log(`\nPage: ${p.name} (${p.path})`);
      console.log(`  color-contrast violations: ${results[p.name].colorContrastNodes.length}`);
      if (results[p.name].colorContrastNodes.length > 0) {
        for (const n of results[p.name].colorContrastNodes) {
          console.log(`    - Target: ${n.target.join(" ")} | Summary: ${n.failureSummary ? n.failureSummary.split("\n")[0] : ""}`);
        }
      }
      console.log(`  link-in-text-block violations: ${results[p.name].linkInTextBlockNodes.length}`);
      if (results[p.name].linkInTextBlockNodes.length > 0) {
        for (const n of results[p.name].linkInTextBlockNodes) {
          console.log(`    - Target: ${n.target.join(" ")} | HTML: ${n.html}`);
        }
      }
      console.log(`  image-redundant-alt violations: ${results[p.name].imageRedundantAltNodes.length}`);
      if (results[p.name].imageRedundantAltNodes.length > 0) {
        for (const n of results[p.name].imageRedundantAltNodes) {
          console.log(`    - Target: ${n.target.join(" ")} | HTML: ${n.html}`);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Summary table
  console.log("\n================================================================================");
  console.log("AUDIT SUMMARY (BEFORE FIXES)");
  console.log("================================================================================");
  console.log("Page        | color-contrast | link-in-text-block | image-redundant-alt");
  console.log("-----------------------------------------------------------------------");
  let totalContrast = 0;
  let totalLink = 0;
  let totalImg = 0;
  for (const [name, res] of Object.entries(results)) {
    const cc = res.colorContrastNodes.length;
    const lk = res.linkInTextBlockNodes.length;
    const im = res.imageRedundantAltNodes.length;
    totalContrast += cc;
    totalLink += lk;
    totalImg += im;
    console.log(`${name.padEnd(11)} | ${String(cc).padStart(14)} | ${String(lk).padStart(18)} | ${String(im).padStart(19)}`);
  }
  console.log("-----------------------------------------------------------------------");
  console.log(`TOTAL       | ${String(totalContrast).padStart(14)} | ${String(totalLink).padStart(18)} | ${String(totalImg).padStart(19)}`);
  console.log("================================================================================\n");

  fs.writeFileSync("reports/a11y-contrast/before-axe-results.json", JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
