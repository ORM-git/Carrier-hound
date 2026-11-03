const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3599;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\095142a5-8fb0-434d-a887-b22dbe29bdd2";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "pricing-redesign");

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}
if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = req.url.split("?")[0].split("#")[0];
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (!path.extname(cleanUrl)) {
      cleanUrl = cleanUrl + ".html";
    }

    const filePath = path.join(OUT_DIR, cleanUrl);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found: " + cleanUrl);
    }
  });
}

async function capture() {
  console.log("Starting static server on port", PORT);
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));

  console.log("Launching Chrome from", CHROME_PATH);
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  try {
    const page = await browser.newPage();

    // 1. Desktop 1440px - Default View (Monthly Selected)
    console.log("Capturing Desktop 1440px - Default View...");
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/pricing`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));

    const desktopDefaultPath = path.join(REPORT_DIR, "desktop-1440-monthly-default.png");
    await page.screenshot({ path: desktopDefaultPath, fullPage: true });
    fs.copyFileSync(desktopDefaultPath, path.join(ARTIFACT_DIR, "desktop-1440-monthly-default.png"));
    console.log("Saved desktop screenshot to", desktopDefaultPath);

    // 2. Desktop 1440px - Interactive Selection of Quarterly Plan
    console.log("Interactively clicking Quarterly Plan...");
    const quarterlyCard = await page.$('div[role="radio"]:nth-child(2)');
    if (quarterlyCard) {
      await quarterlyCard.click();
      await new Promise((r) => setTimeout(r, 400));
      const desktopQuarterlyPath = path.join(REPORT_DIR, "desktop-1440-quarterly-selected.png");
      await page.screenshot({ path: desktopQuarterlyPath, fullPage: true });
      fs.copyFileSync(desktopQuarterlyPath, path.join(ARTIFACT_DIR, "desktop-1440-quarterly-selected.png"));
      console.log("Saved quarterly selected screenshot to", desktopQuarterlyPath);
    }

    // 3. Desktop 1440px - Interactive Selection of Weekly Plan
    console.log("Interactively clicking Weekly Plan...");
    const weeklyCard = await page.$('div[role="radio"]:nth-child(3)');
    if (weeklyCard) {
      await weeklyCard.click();
      await new Promise((r) => setTimeout(r, 400));
      const desktopWeeklyPath = path.join(REPORT_DIR, "desktop-1440-weekly-selected.png");
      await page.screenshot({ path: desktopWeeklyPath, fullPage: true });
      fs.copyFileSync(desktopWeeklyPath, path.join(ARTIFACT_DIR, "desktop-1440-weekly-selected.png"));
      console.log("Saved weekly selected screenshot to", desktopWeeklyPath);
    }

    // 4. Test Zero Checkout Activation: Click Upgrade button
    console.log("Verifying Upgrade button is inert / disabled (zero checkout)...");
    const buttons = await page.$$("button[disabled]");
    let upgradeButton = null;
    let buttonText = "";
    for (const btn of buttons) {
      const text = await page.evaluate((b) => b.innerText.trim(), btn);
      if (text.includes("Payments opening soon")) {
        upgradeButton = btn;
        buttonText = text;
        break;
      }
    }
    if (!upgradeButton) {
      throw new Error("Could not find button with text 'Payments opening soon'!");
    }
    const isDisabled = await page.evaluate((btn) => btn.disabled, upgradeButton);
    console.log(`Upgrade button text: "${buttonText}", disabled property: ${isDisabled}`);
    if (!isDisabled || buttonText !== "Payments opening soon") {
      throw new Error(`Upgrade button verification failed! text="${buttonText}", disabled=${isDisabled}`);
    }

    // 5. Mobile 390px Viewport (iPhone 14 / Jobright mobile reference)
    console.log("Capturing Mobile 390px Viewport...");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/pricing`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));

    const mobile390Path = path.join(REPORT_DIR, "mobile-390-full.png");
    await page.screenshot({ path: mobile390Path, fullPage: true });
    fs.copyFileSync(mobile390Path, path.join(ARTIFACT_DIR, "mobile-390-full.png"));
    console.log("Saved mobile 390px screenshot to", mobile390Path);

    // 6. Mobile 360px Viewport (Android compact)
    console.log("Capturing Mobile 360px Viewport...");
    await page.setViewport({ width: 360, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/pricing`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 800));

    const mobile360Path = path.join(REPORT_DIR, "mobile-360-full.png");
    await page.screenshot({ path: mobile360Path, fullPage: true });
    fs.copyFileSync(mobile360Path, path.join(ARTIFACT_DIR, "mobile-360-full.png"));
    console.log("Saved mobile 360px screenshot to", mobile360Path);

    console.log("All screenshots successfully captured!");
  } finally {
    await browser.close();
    server.close();
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
