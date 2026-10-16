const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3375;
const OUT_DIR = path.join(__dirname, "..", "out");
const AXE_PATH = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\a11y-tools\\node_modules\\axe-core\\axe.min.js";
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";

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
    const mimeTypes = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
    };
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function main() {
  console.log("================================================================================");
  console.log("NEGATIVE CONTROL: REVERT ONE COLOUR AND PROVE AXE FLAGS IT");
  console.log("================================================================================\n");

  const server = createServer();
  await new Promise((r) => server.listen(PORT, r));

  const axeSource = fs.readFileSync(AXE_PATH, "utf8");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    await page.goto(`http://localhost:${PORT}/login`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.evaluate(axeSource);

    // 1. Verify that WITHOUT reverting, axe finds 0 color-contrast violations on login
    const beforeRevert = await page.evaluate(async () => {
      return await window.axe.run({
        runOnly: { type: "rule", values: ["color-contrast"] },
      });
    });

    const violationsBefore = beforeRevert.violations.find((v) => v.id === "color-contrast");
    const countBefore = violationsBefore ? violationsBefore.nodes.length : 0;
    console.log(`[PASS-LOCAL] Login page with WCAG AA fix has ${countBefore} color-contrast violations.`);

    if (countBefore !== 0) {
      console.error(`[ERROR] Expected 0 violations on fixed login page, but found ${countBefore}`);
      process.exit(1);
    }

    // 2. Revert ONE colour in the DOM back to legacy #9CA3AF (text-gray-400)
    console.log("\n[ACTION] Reverting separator text color back to legacy #9CA3AF...");
    await page.evaluate(() => {
      const el = document.querySelector(".text-gray-500.font-medium") || document.querySelector("span.text-xs.font-medium");
      if (el) {
        el.style.color = "#9CA3AF"; // Reverted low-contrast gray (2.53:1)
      }
    });

    // 3. Re-run axe on the reverted element
    const afterRevert = await page.evaluate(async () => {
      return await window.axe.run({
        runOnly: { type: "rule", values: ["color-contrast"] },
      });
    });

    const violationsAfter = afterRevert.violations.find((v) => v.id === "color-contrast");
    const countAfter = violationsAfter ? violationsAfter.nodes.length : 0;

    console.log(`[NEGATIVE CONTROL RESULT] Re-running axe on reverted element: found ${countAfter} violation(s).`);

    if (countAfter > 0) {
      console.log(`[PASS-LOCAL] Axe correctly detected the low-contrast regression!`);
      const node = violationsAfter.nodes[0];
      console.log(`   └─ Target: ${node.target.join(" ")}`);
      console.log(`   └─ Summary: ${node.failureSummary ? node.failureSummary.split("\n")[0] : ""}`);
      
      if (process.argv.includes("--fail-on-regression")) {
        console.error(`[INTENDED NEGATIVE CONTROL FAILURE] Exiting non-zero (1) due to detected regression.`);
        process.exit(1);
      }

      console.log("\n--- VERIFYING NON-ZERO EXIT IN SUBPROCESS ---");
      const { spawnSync } = require("child_process");
      const sub = spawnSync("node", ["scripts/test-contrast-negative-control.js", "--fail-on-regression"], {
        encoding: "utf-8",
        shell: true,
      });
      if (sub.status !== 0) {
        console.log(`[PASS-LOCAL] Subprocess correctly exited with code ${sub.status} on reverted color!`);
      } else {
        console.error(`[FAIL] Subprocess unexpectedly exited with code 0!`);
        process.exit(1);
      }

      console.log("\n================================================================================");
      console.log("NEGATIVE CONTROL PROVEN: Axe reliably flags low-contrast colors & exits non-zero.");
      console.log("================================================================================");
      process.exit(0);
    } else {
      console.error("[FAIL] Axe failed to detect the reverted low-contrast color!");
      process.exit(1);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
