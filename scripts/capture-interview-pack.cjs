const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3499;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\c5deb1a1-59c2-4f16-b151-2ec9625c9084";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "interview-pack");

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

const MIME_TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function createServer() {
  return http.createServer((req, res) => {
    let cleanUrl = decodeURIComponent(req.url.split("?")[0].split("#")[0]);
    if (cleanUrl === "/") cleanUrl = "/index.html";
    if (!path.extname(cleanUrl)) {
      if (fs.existsSync(path.join(OUT_DIR, cleanUrl + ".html"))) {
        cleanUrl = cleanUrl + ".html";
      } else if (fs.existsSync(path.join(OUT_DIR, cleanUrl, "index.html"))) {
        cleanUrl = path.join(cleanUrl, "index.html");
      }
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

const sampleSession = {
  access_token: "mock-jwt-token-alex-candidate",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: "mock-refresh-token",
  user: {
    id: "usr_mock_123",
    aud: "authenticated",
    role: "authenticated",
    email: "alex.candidate@careermonke.com",
    email_confirmed_at: new Date().toISOString(),
    user_metadata: {
      full_name: "Alex Candidate",
      name: "Alex Candidate",
      is_pro: true,
      pro_granted: true,
    },
  },
};

const sampleProfile = {
  userId: "usr_mock_123",
  fullName: "Alex Candidate",
  name: "Alex Candidate",
  email: "alex.candidate@careermonke.com",
  headline: "Senior Full-Stack Engineer",
  summary: "5+ years building scalable web applications with TypeScript, React, and Node.js.",
  skills: ["TypeScript", "Next.js", "React", "Node.js", "PostgreSQL", "Docker", "Tailwind CSS"],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function setupPageAuth(page) {
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
      value: "alex.candidate@careermonke.com",
      domain: "localhost",
      path: "/",
    }
  );

  await page.evaluateOnNewDocument(
    (sess, prof) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_user_email", prof.email);
      localStorage.setItem(
        "careermonke_entitlement_v2",
        JSON.stringify({
          isPro: true,
          tier: "pro_monthly",
          status: "active",
          expiresAt: null,
          isDefinitive: true,
          cachedAt: Date.now(),
        })
      );
      localStorage.setItem("careermonke_pro_active", "true");
      localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
      localStorage.setItem(
        "careermonke_user_preferences",
        JSON.stringify({
          onboardingCompleted: true,
        })
      );
    },
    sampleSession,
    sampleProfile
  );
}

async function capture() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Server listening on port ${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    // 1. Desktop - Step 1: Fear Question Screen
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await setupPageAuth(page);
      await page.goto(`http://localhost:${PORT}/jobs/sample/interview-pack`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1200));

      const file1 = "interview-pack-desktop-step1.png";
      await page.screenshot({ path: path.join(REPORT_DIR, file1), fullPage: false });
      if (fs.existsSync(ARTIFACT_DIR)) {
        fs.copyFileSync(path.join(REPORT_DIR, file1), path.join(ARTIFACT_DIR, file1));
      }
      console.log(`Captured ${file1}`);
      await page.close();
    }

    // 2. Desktop - Step 2: Time Box Screen
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await setupPageAuth(page);
      await page.goto(`http://localhost:${PORT}/jobs/sample/interview-pack`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1000));

      // Click Skip on Fear Question Screen
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const skip = btns.find((b) => b.textContent && b.textContent.includes("Skip"));
        if (skip) skip.click();
      });
      await new Promise((r) => setTimeout(r, 800));

      const file2 = "interview-pack-desktop-step2.png";
      await page.screenshot({ path: path.join(REPORT_DIR, file2), fullPage: false });
      if (fs.existsSync(ARTIFACT_DIR)) {
        fs.copyFileSync(path.join(REPORT_DIR, file2), path.join(ARTIFACT_DIR, file2));
      }
      console.log(`Captured ${file2}`);
      await page.close();
    }

    // 3. Desktop - Step 3: Main Dossier with Questions Card Deck
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await setupPageAuth(page);
      await page.goto(`http://localhost:${PORT}/jobs/sample/interview-pack`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1000));

      // Skip Step 1
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const skip = btns.find((b) => b.textContent.includes("Skip"));
        if (skip) skip.click();
      });
      await new Promise((r) => setTimeout(r, 600));

      // Select 30 min on Step 2
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const time30 = btns.find((b) => b.textContent.includes("30 min"));
        if (time30) time30.click();
      });
      await new Promise((r) => setTimeout(r, 1200));

      const file3 = "interview-pack-desktop-dossier.png";
      await page.screenshot({ path: path.join(REPORT_DIR, file3), fullPage: false });
      if (fs.existsSync(ARTIFACT_DIR)) {
        fs.copyFileSync(path.join(REPORT_DIR, file3), path.join(ARTIFACT_DIR, file3));
      }
      console.log(`Captured ${file3}`);
      await page.close();
    }

    // 4. Mobile - 390px Step 3 Dossier
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await setupPageAuth(page);
      await page.goto(`http://localhost:${PORT}/jobs/sample/interview-pack`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1000));

      // Skip Step 1
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const skip = btns.find((b) => b.textContent.includes("Skip"));
        if (skip) skip.click();
      });
      await new Promise((r) => setTimeout(r, 600));

      // Select 30 min on Step 2
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const time30 = btns.find((b) => b.textContent.includes("30 min"));
        if (time30) time30.click();
      });
      await new Promise((r) => setTimeout(r, 1200));

      const file4 = "interview-pack-mobile-390.png";
      await page.screenshot({ path: path.join(REPORT_DIR, file4), fullPage: false });
      if (fs.existsSync(ARTIFACT_DIR)) {
        fs.copyFileSync(path.join(REPORT_DIR, file4), path.join(ARTIFACT_DIR, file4));
      }
      console.log(`Captured ${file4}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

capture().catch((err) => {
  console.error("Capture error:", err);
  process.exit(1);
});
