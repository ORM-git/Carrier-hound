const path = require("path");
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPORTS_DIR = path.resolve(__dirname, "..", "reports", "prompt2-shell");

async function compareImages(img1Name, img2Name, diffOutputName) {
  const img1Path = path.join(REPORTS_DIR, img1Name);
  const img2Path = path.join(REPORTS_DIR, img2Name);
  const diffPath = path.join(REPORTS_DIR, diffOutputName);

  if (!fs.existsSync(img1Path) || !fs.existsSync(img2Path)) {
    throw new Error(`Images not found: ${img1Path} or ${img2Path}`);
  }

  const img1Data = fs.readFileSync(img1Path).toString("base64");
  const img2Data = fs.readFileSync(img2Path).toString("base64");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  const html = `
    <!DOCTYPE html>
    <html>
      <body>
        <canvas id="c1"></canvas>
        <canvas id="c2"></canvas>
        <canvas id="diff"></canvas>
      </body>
    </html>
  `;
  await page.setContent(html);

  const result = await page.evaluate(
    async (b64_1, b64_2) => {
      const loadImg = (b64) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = "data:image/png;base64," + b64;
        });

      const i1 = await loadImg(b64_1);
      const i2 = await loadImg(b64_2);

      const width = Math.max(i1.width, i2.width);
      const height = Math.max(i1.height, i2.height);

      const c1 = document.getElementById("c1");
      c1.width = width;
      c1.height = height;
      const ctx1 = c1.getContext("2d");
      ctx1.drawImage(i1, 0, 0);
      const d1 = ctx1.getImageData(0, 0, width, height).data;

      const c2 = document.getElementById("c2");
      c2.width = width;
      c2.height = height;
      const ctx2 = c2.getContext("2d");
      ctx2.drawImage(i2, 0, 0);
      const d2 = ctx2.getImageData(0, 0, width, height).data;

      const cDiff = document.getElementById("diff");
      cDiff.width = width;
      cDiff.height = height;
      const ctxDiff = cDiff.getContext("2d");
      const imgDiff = ctxDiff.createImageData(width, height);
      const out = imgDiff.data;

      let totalDiff = 0;
      let maxDiffPerPixel = 0;

      for (let i = 0; i < d1.length; i += 4) {
        const rDiff = Math.abs(d1[i] - d2[i]);
        const gDiff = Math.abs(d1[i + 1] - d2[i + 1]);
        const bDiff = Math.abs(d1[i + 2] - d2[i + 2]);
        const aDiff = Math.abs(d1[i + 3] - d2[i + 3]);
        const delta = rDiff + gDiff + bDiff + aDiff;

        if (delta > 0) {
          totalDiff++;
          maxDiffPerPixel = Math.max(maxDiffPerPixel, delta);
          // Highlight diff in red
          out[i] = 255;
          out[i + 1] = 0;
          out[i + 2] = 0;
          out[i + 3] = 255;
        } else {
          // Dim unchanged
          out[i] = Math.floor(d1[i] * 0.2);
          out[i + 1] = Math.floor(d1[i + 1] * 0.2);
          out[i + 2] = Math.floor(d1[i + 2] * 0.2);
          out[i + 3] = 255;
        }
      }

      ctxDiff.putImageData(imgDiff, 0, 0);
      const diffDataUrl = cDiff.toDataURL("image/png");

      return {
        width,
        height,
        totalPixels: width * height,
        diffPixels: totalDiff,
        diffPercent: (totalDiff / (width * height)) * 100,
        maxDiffPerPixel,
        diffDataUrl,
      };
    },
    img1Data,
    img2Data
  );

  await browser.close();

  if (result.diffDataUrl) {
    const base64Data = result.diffDataUrl.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(diffPath, Buffer.from(base64Data, "base64"));
  }

  return result;
}

async function run() {
  console.log("Comparing desktop viewport screenshots...");
  const desktopResult = await compareImages(
    "landing-before-desktop.png",
    "landing-after-desktop.png",
    "landing-diff-desktop.png"
  );
  console.log(
    `Desktop: ${desktopResult.diffPixels} / ${desktopResult.totalPixels} pixels differ (${desktopResult.diffPercent.toFixed(
      4
    )}%)`
  );

  console.log("\nComparing full page screenshots...");
  const fullResult = await compareImages(
    "landing-before-full.png",
    "landing-after-full.png",
    "landing-diff-full.png"
  );
  console.log(
    `Full Page: ${fullResult.diffPixels} / ${fullResult.totalPixels} pixels differ (${fullResult.diffPercent.toFixed(
      4
    )}%)`
  );
}

run().catch((err) => {
  console.error("Comparison failed:", err);
  process.exit(1);
});
