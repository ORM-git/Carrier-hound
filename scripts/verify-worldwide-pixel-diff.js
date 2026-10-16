const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_BEFORE = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\out-before-worldwide";
const OUT_AFTER = path.join(__dirname, "..", "out");

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

    let filePath = path.join(dir, cleanUrl);

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (fs.existsSync(filePath + ".html")) {
        filePath = filePath + ".html";
      } else if (fs.existsSync(path.join(filePath, "index.html"))) {
        filePath = path.join(filePath, "index.html");
      }
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found: " + cleanUrl);
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

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

async function captureScreenshot(browser, url, vp) {
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: vp.width,
      height: vp.height,
      isMobile: vp.isMobile,
      hasTouch: vp.hasTouch,
      deviceScaleFactor: 1,
    });

    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });

    await page.evaluate(() => {
      // Freeze any CSS animations and timers
      const style = document.createElement("style");
      style.textContent = `
        *, *::before, *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          transition-delay: 0s !important;
          transition-duration: 0s !important;
          caret-color: transparent !important;
        }
      `;
      document.head.appendChild(style);
    });

    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 500));

    const buf = await page.screenshot({ fullPage: false, type: "png" });
    return buf.toString("base64");
  } finally {
    await page.close();
  }
}

async function runPixelmatchInBrowser(evalPage, b64_1, b64_2, width, height, simulateDiff = false) {
  return await evalPage.evaluate(
    async ({ s1, s2, w, h, simulateDiff }) => {
      function loadImage(src) {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.src = "data:image/png;base64," + src;
        });
      }

      const img1 = await loadImage(s1);
      const img2 = await loadImage(s2);

      const canvas1 = document.createElement("canvas");
      canvas1.width = w;
      canvas1.height = h;
      const ctx1 = canvas1.getContext("2d");
      ctx1.drawImage(img1, 0, 0);
      const imgData1 = ctx1.getImageData(0, 0, w, h);

      const canvas2 = document.createElement("canvas");
      canvas2.width = w;
      canvas2.height = h;
      const ctx2 = canvas2.getContext("2d");
      ctx2.drawImage(img2, 0, 0);

      if (simulateDiff) {
        // Intentionally modify 1 pixel in memory for negative control
        const testData = ctx2.getImageData(0, 0, w, h);
        testData.data[0] = (testData.data[0] + 128) % 256;
        ctx2.putImageData(testData, 0, 0);
      }
      const imgData2 = ctx2.getImageData(0, 0, w, h);

      const data1 = imgData1.data;
      const data2 = imgData2.data;

      function rgb2y(r, g, b) { return r * 0.29889531 + g * 0.58662247 + b * 0.11448223; }
      function rgb2i(r, g, b) { return r * 0.59597799 - g * 0.27417610 - b * 0.32180189; }
      function rgb2q(r, g, b) { return r * 0.21147017 - g * 0.52261711 + b * 0.31114694; }

      function colorDelta(pos1, pos2) {
        let r1 = data1[pos1], g1 = data1[pos1 + 1], b1 = data1[pos1 + 2], a1 = data1[pos1 + 3];
        let r2 = data2[pos2], g2 = data2[pos2 + 1], b2 = data2[pos2 + 2], a2 = data2[pos2 + 3];
        if (a1 === a2 && r1 === r2 && g1 === g2 && b1 === b2) return 0;
        let y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
        let i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
        let q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
        let delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
        return Math.abs(a1 - a2) > 0 ? delta + Math.abs(a1 - a2) : delta;
      }

      const maxDelta = 35215 * 0.05 * 0.05;
      let mismatched = 0;
      let minX = w, minY = h, maxX = 0, maxY = 0;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pos = (y * w + x) * 4;
          const delta = colorDelta(pos, pos);
          if (delta > maxDelta) {
            mismatched++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      const totalPixels = w * h;
      const diffPercent = (mismatched / totalPixels) * 100;

      return {
        mismatched,
        totalPixels,
        diffPercent,
        bounds: mismatched > 0 ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
      };
    },
    { s1: b64_1, s2: b64_2, w: width, h: height, simulateDiff }
  );
}

async function runComparison(isNegativeControl) {
  const serverBefore = await createStaticServer(OUT_BEFORE, 3351);
  const serverAfter = await createStaticServer(OUT_AFTER, 3352);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const evalPage = await browser.newPage();
    let anyMismatch = false;

    for (const vp of VIEWPORTS) {
      const urlBefore = `http://localhost:3351/worldwide`;
      const urlAfter = `http://localhost:3352/worldwide`;

      const b64_before = await captureScreenshot(browser, urlBefore, vp);
      const b64_after = await captureScreenshot(browser, urlAfter, vp);

      const diffResult = await runPixelmatchInBrowser(
        evalPage,
        b64_before,
        b64_after,
        vp.width,
        vp.height,
        isNegativeControl && vp.name === "390"
      );

      const diffPctFormatted = diffResult.diffPercent.toFixed(4);
      console.log(
        `Page: /worldwide | Viewport: ${vp.name.padStart(4)}px | Total: ${diffResult.totalPixels} px | Mismatched: ${diffResult.mismatched} px | Diff: ${diffPctFormatted}%`
      );

      if (diffResult.mismatched > 0) {
        anyMismatch = true;
        if (isNegativeControl) {
          console.error(`[NEGATIVE CONTROL INTENDED FAILURE] Mismatch detected: ${diffResult.mismatched} px (${diffPctFormatted}%). Exiting non-zero.`);
          process.exit(1);
        } else {
          console.error(`[FAIL] Mismatch detected: ${diffResult.mismatched} px (${diffPctFormatted}%)`);
          console.error(`Bounds:`, diffResult.bounds);
          process.exit(1);
        }
      }
    }

    if (isNegativeControl && !anyMismatch) {
      console.error("[NEGATIVE CONTROL ERROR] Failed to detect simulated mismatch!");
      process.exit(0);
    }
  } finally {
    if (browser) await browser.close();
    serverBefore.close();
    serverAfter.close();
  }
}

async function main() {
  if (process.argv.includes("--negative-control")) {
    console.log("================================================================================");
    console.log("NEGATIVE CONTROL: /worldwide PIXEL-DIFF (Simulating 1-pixel color change)");
    console.log("================================================================================");
    await runComparison(true);
    return;
  }

  console.log("================================================================================");
  console.log("TEST SUITE: /worldwide PIXEL-DIFF VERIFICATION (BASELINE vs FALLBACK-ACTIVE)");
  console.log("================================================================================\n");

  await runComparison(false);
  console.log("\n[PASS-LOCAL] /worldwide is 0.0000% pixel-identical across all viewports.\n");

  console.log("--- RUNNING NEGATIVE CONTROL VIA SUBPROCESS ---");
  const neg = spawnSync("node", ["scripts/verify-worldwide-pixel-diff.js", "--negative-control"], {
    encoding: "utf-8",
    shell: true,
  });
  if (neg.status !== 0) {
    console.log("[PASS-LOCAL] Negative control exited non-zero as expected (exit code: " + neg.status + ")");
    console.log(neg.stderr.trim() || neg.stdout.trim());
  } else {
    console.error("[FAIL] Negative control exited 0 unexpectedly!");
    process.exit(1);
  }

  console.log("\n================================================================================");
  console.log("PIXEL-DIFF VERIFICATION COMPLETE: ALL ASSERTIONS & CONTROLS PASSED");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
