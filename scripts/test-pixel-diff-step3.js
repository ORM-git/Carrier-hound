const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const OUT_PR21 = "C:\\Users\\ASUS\\AppData\\Local\\Temp\\out-after";
const OUT_STEP3 = path.join(__dirname, "..", "out");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\caf034a4-a523-4c7f-8755-7fa4fad550ba\\diffs";

if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

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
    if (cleanUrl === "/privacy") cleanUrl = "/privacy-policy.html";
    if (cleanUrl === "/terms") cleanUrl = "/terms-and-conditions.html";

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

const ROUTES = [
  { name: "home", path: "/" },
  { name: "login", path: "/login" },
  { name: "signup", path: "/signup" },
  { name: "jobs", path: "/jobs" },
  { name: "radar", path: "/radar", maskCanvas: true },
  { name: "privacy", path: "/privacy" },
  { name: "terms", path: "/terms" },
];

const VIEWPORTS = [
  { name: "390", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "1440", width: 1440, height: 900, isMobile: false, hasTouch: false },
];

const imageCache = {};

const AVATAR_URLS = [
  "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=96&h=96&q=75",
  "https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?auto=format&fit=crop&w=96&h=96&q=75",
];

async function preloadExternalImages() {
  for (const url of AVATAR_URLS) {
    try {
      const resp = await fetch(url);
      const arrayBuf = await resp.arrayBuffer();
      imageCache[url] = {
        status: 200,
        headers: { "content-type": resp.headers.get("content-type") || "image/jpeg" },
        body: Buffer.from(arrayBuf),
      };
    } catch (_) {}
  }
}

const TRANSPARENT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAentry==",
  "base64"
);

async function captureScreenshot(browser, url, vp, maskCanvas) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const u = req.url();
      if (imageCache[u]) {
        return req.respond(imageCache[u]);
      }
      if (u.includes("unavatar.io") || u.includes("gstatic.com")) {
        return req.respond({
          status: 200,
          headers: { "content-type": "image/png" },
          body: TRANSPARENT_PNG,
        });
      }
      req.continue();
    });

    await page.setViewport(vp);
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0.001ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.001ms !important;
          caret-color: transparent !important;
        }
        ${maskCanvas ? "canvas { visibility: hidden !important; }" : ""}
      `,
    });

    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 1200));

    const buf = await page.screenshot({ fullPage: false });
    return buf.toString("base64");
  } finally {
    await page.close();
  }
}

async function runPixelmatchInBrowser(evalPage, b64_1, b64_2, width, height, isNegativeControl) {
  return await evalPage.evaluate(
    async ({ s1, s2, w, h, simulateDiff }) => {
      function loadImage(src) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      }

      const [img1, img2] = await Promise.all([
        loadImage("data:image/png;base64," + s1),
        loadImage("data:image/png;base64," + s2),
      ]);

      const c1 = document.createElement("canvas");
      c1.width = w;
      c1.height = h;
      const ctx1 = c1.getContext("2d");
      ctx1.drawImage(img1, 0, 0, w, h);
      const d1 = ctx1.getImageData(0, 0, w, h).data;

      const c2 = document.createElement("canvas");
      c2.width = w;
      c2.height = h;
      const ctx2 = c2.getContext("2d");
      ctx2.drawImage(img2, 0, 0, w, h);
      const imgData2 = ctx2.getImageData(0, 0, w, h);
      const d2 = imgData2.data;

      if (simulateDiff) {
        d2[0] = (d2[0] + 128) % 256;
      }

      function rgb2y(r, g, b) { return r * 0.29889531 + g * 0.58662871 + b * 0.11447598; }
      function rgb2i(r, g, b) { return r * 0.59597799 - g * 0.27417610 - b * 0.32180189; }
      function rgb2q(r, g, b) { return r * 0.21147017 - g * 0.52261711 + b * 0.31114694; }
      function blend(c, a) { return 255 + (c - 255) * a; }

      function colorDelta(k, m, yOnly) {
        let a1 = d1[k + 3] / 255;
        let a2 = d2[m + 3] / 255;
        let r1 = blend(d1[k], a1);
        let g1 = blend(d1[k + 1], a1);
        let b1 = blend(d1[k + 2], a1);
        let r2 = blend(d2[m], a2);
        let g2 = blend(d2[m + 1], a2);
        let b2 = blend(d2[m + 2], a2);
        let y = rgb2y(r1, g1, b1) - rgb2y(r2, g2, b2);
        if (yOnly) return y;
        let i = rgb2i(r1, g1, b1) - rgb2i(r2, g2, b2);
        let q = rgb2q(r1, g1, b1) - rgb2q(r2, g2, b2);
        let delta = 0.5053 * y * y + 0.299 * i * i + 0.1957 * q * q;
        return Math.abs(a1 - a2) > 0 ? (delta + Math.abs(a1 - a2)) : delta;
      }

      const maxDelta = 35215 * 0.05 * 0.05;
      let mismatched = 0;
      let minX = w, minY = h, maxX = 0, maxY = 0;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const pos = (y * w + x) * 4;
          const delta = colorDelta(pos, pos, false);

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
    { s1: b64_1, s2: b64_2, w: width, h: height, simulateDiff: isNegativeControl }
  );
}

async function main() {
  const isNegativeControl = process.argv.includes("--negative-control");
  console.log("==================================================================================");
  console.log("   STEP 3 PIXEL-DIFF VERIFICATION (PR #21 BASELINE vs PR #22 WITH <MAIN> LANDMARKS) ");
  if (isNegativeControl) {
    console.log("   MODE: NEGATIVE CONTROL (Simulating 1-pixel mismatch in memory)                  ");
  }
  console.log("==================================================================================\n");

  await preloadExternalImages();

  const serverBefore = await createStaticServer(OUT_PR21, 3343);
  const serverAfter = await createStaticServer(OUT_STEP3, 3344);

  let browser;
  let hasFailure = false;

  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const evalPage = await browser.newPage();

    for (const route of ROUTES) {
      for (const vp of VIEWPORTS) {
        const urlBefore = `http://localhost:3343${route.path}`;
        const urlAfter = `http://localhost:3344${route.path}`;

        const b64_before = await captureScreenshot(browser, urlBefore, vp, route.maskCanvas);
        const b64_after = await captureScreenshot(browser, urlAfter, vp, route.maskCanvas);

        const diffResult = await runPixelmatchInBrowser(
          evalPage,
          b64_before,
          b64_after,
          vp.width,
          vp.height,
          isNegativeControl && route.name === "home" && vp.name === "390"
        );

        const diffPctFormatted = diffResult.diffPercent.toFixed(4);
        console.log(
          `Page: ${route.path.padEnd(8)} | Viewport: ${vp.name.padStart(4)}px | Total: ${diffResult.totalPixels} px | Mismatched: ${diffResult.mismatched} px | Diff: ${diffPctFormatted}%`
        );

        if (diffResult.mismatched > 0) {
          hasFailure = true;
          console.error(`\n[DIFF DETECTED] Route ${route.path} @ ${vp.name}px has mismatched pixels!`);
          console.error(`Bounds: x=${diffResult.bounds.minX}..${diffResult.bounds.maxX}, y=${diffResult.bounds.minY}..${diffResult.bounds.maxY} (w=${diffResult.bounds.width}, h=${diffResult.bounds.height})`);

          if (isNegativeControl) {
            console.log("\n[NEGATIVE CONTROL] PASS-LOCAL: Single-pixel difference correctly detected non-zero mismatch.");
            process.exit(1);
          } else {
            console.error("STOPPING: Diff percent above 0.0000%!");
            process.exit(1);
          }
        }
      }
    }

    if (isNegativeControl) {
      if (hasFailure) {
        console.log("\n[NEGATIVE CONTROL] PASS-LOCAL: Single-pixel difference correctly detected non-zero mismatch.");
        process.exit(1);
      } else {
        console.error("\n[NEGATIVE CONTROL] FAILED: Negative control did not detect simulated mismatch!");
        process.exit(0);
      }
    }

    if (hasFailure) {
      console.log("\nVERDICT: FAIL - Visual diff detected differences after adding <main> landmarks.");
      process.exit(1);
    } else {
      console.log("\nVERDICT: PASS-LOCAL (0.0000% diff across all 14 test combinations)");
      process.exit(0);
    }
  } catch (err) {
    console.error("Execution error:", err);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    serverBefore.close();
    serverAfter.close();
  }
}

main();
