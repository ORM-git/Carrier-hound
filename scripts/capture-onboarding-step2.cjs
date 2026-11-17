const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3601;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\095142a5-8fb0-434d-a887-b22dbe29bdd2\\onboarding-screenshots";

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
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Static server running at http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();
    page.on("console", (msg) => {
      const txt = msg.text();
      if (!txt.includes("Download the React DevTools")) {
        console.log("BROWSER:", txt);
      }
    });

    const sampleUser = {
      id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      email: "alex.morgan@example.com",
      user_metadata: { full_name: "Alex Morgan" },
      aud: "authenticated",
      role: "authenticated",
    };

    const sampleSession = {
      access_token: "mock-bearer-token",
      refresh_token: "mock-refresh",
      expires_in: 3600,
      token_type: "bearer",
      user: sampleUser,
    };

    const cookieValue = encodeURIComponent(JSON.stringify(sampleSession));
    await page.setCookie(
      {
        name: "sb-szakevhxhwpeskidvtfs-auth-token",
        value: cookieValue,
        domain: "localhost",
        path: "/",
      },
      {
        name: "careermonke_user_email",
        value: "alex.morgan@example.com",
        domain: "localhost",
        path: "/",
      }
    );

    await page.evaluateOnNewDocument((sess) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_user_email", sess.user.email);
    }, sampleSession);

    // 1. Desktop - Step 2 Initial Enabled State (1280x800)
    console.log("Capturing 1: Desktop Initial Step 2...");
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/onboarding?step=2`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-desktop-enabled.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-desktop-enabled.png");

    // 2. Mobile - Step 2 Initial Enabled State (390x844)
    console.log("Capturing 2: Mobile Initial Step 2 (390px)...");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/onboarding?step=2`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-mobile-enabled.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-mobile-enabled.png");

    // 3. Mobile - LinkedIn URL Invalid Validation State (390px)
    console.log("Capturing 3: Mobile LinkedIn Validation Error (390px)...");
    const linkedInInput = await page.$('input[placeholder*="linkedin.com/in/"]');
    if (linkedInInput) {
      await linkedInInput.click({ clickCount: 3 });
      await linkedInInput.type("https://www.linkedin.com/company/google");
      // Find and click the Save button for LinkedIn
      const saveButtons = await page.$$("button");
      for (const btn of saveButtons) {
        const text = await page.evaluate((el) => el.innerText, btn);
        if (text && text.trim() === "Save") {
          await btn.click();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-linkedin-invalid-mobile.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-linkedin-invalid-mobile.png");

    // 4. Desktop - LinkedIn URL Valid Saved State (1280x800)
    console.log("Capturing 4: Desktop LinkedIn Saved State...");
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/onboarding?step=2`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 500));
    const linkedInInputDesktop = await page.$('input[placeholder*="linkedin.com/in/"]');
    if (linkedInInputDesktop) {
      await linkedInInputDesktop.click({ clickCount: 3 });
      await linkedInInputDesktop.type("https://www.linkedin.com/in/alex-morgan-dev");
      const saveButtons = await page.$$("button");
      for (const btn of saveButtons) {
        const text = await page.evaluate((el) => el.innerText, btn);
        if (text && text.trim() === "Save") {
          await btn.click();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-linkedin-saved-desktop.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-linkedin-saved-desktop.png");

    // 5. Mobile - Resume File Type Rejection Error State (390px)
    console.log("Capturing 5: Mobile Resume File Type Rejection (390px)...");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/onboarding?step=2`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 500));

    // Create a temporary invalid file (.exe or fake extension)
    const tempInvalidPath = path.resolve(process.cwd(), "temp_invalid.exe");
    fs.writeFileSync(tempInvalidPath, "MZ...not a resume");
    const fileInputMobile = await page.$('input[type="file"]');
    if (fileInputMobile) {
      await fileInputMobile.uploadFile(tempInvalidPath);
      await new Promise((r) => setTimeout(r, 600));
    }
    try { fs.unlinkSync(tempInvalidPath); } catch {}

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-resume-error-mobile.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-resume-error-mobile.png");

    // 6. Desktop - Resume Upload & Parsing Success State (1280x800)
    console.log("Capturing 6: Desktop Resume Upload Success...");
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    await page.goto(`http://localhost:${PORT}/onboarding?step=2`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 500));

    const tempValidPdf = path.resolve(process.cwd(), "Alex_Morgan_Resume.pdf");
    fs.writeFileSync(tempValidPdf, "%PDF-1.4\n1 0 obj\n<< /Title (Resume) >>\nendobj\n(TypeScript React Node.js PostgreSQL) Tj\n%%EOF");
    const fileInputDesktop = await page.$('input[type="file"]');
    if (fileInputDesktop) {
      await fileInputDesktop.uploadFile(tempValidPdf);
      await new Promise((r) => setTimeout(r, 600));
    }
    try { fs.unlinkSync(tempValidPdf); } catch {}

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-resume-success-desktop.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-resume-success-desktop.png");

    // 7. Desktop - Feature Flag OFF "Coming Soon" State (1280x800)
    console.log("Capturing 7: Desktop Feature Flag OFF (Coming Soon)...");
    await page.goto(`http://localhost:${PORT}/onboarding?step=2&step2_enabled=false`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-comingsoon-desktop.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-comingsoon-desktop.png");

    // 8. Mobile - Feature Flag OFF "Coming Soon" State (390px)
    console.log("Capturing 8: Mobile Feature Flag OFF (Coming Soon 390px)...");
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(`http://localhost:${PORT}/onboarding?step=2&step2_enabled=false`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "onboarding-step2-comingsoon-mobile.png"),
      fullPage: false,
    });
    console.log("  Saved onboarding-step2-comingsoon-mobile.png");

  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

capture()
  .then(() => {
    console.log("All screenshots captured successfully.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Screenshot capture failed:", err);
    process.exit(1);
  });
