const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3488;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\c5deb1a1-59c2-4f16-b151-2ec9625c9084";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "prompt10-paywall");

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
      res.end("Not Found");
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
  experience: [
    {
      company: "Tech Systems",
      role: "Senior Full-Stack Developer",
      startDate: "2021",
      endDate: "Present",
      bullets: ["Architected scalable web applications using React and Node.js microservices."],
    },
  ],
  education: [
    {
      degree: "BS Computer Science",
      institution: "State University",
      year: "2020",
    },
  ],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const samplePreferences = {
  roles: ["Full-Stack Developer", "Frontend Developer"],
  experienceLevel: "senior",
  remotePreference: "remote",
  locations: ["Worldwide / Remote", "United States"],
  employmentTypes: ["full-time"],
  dailyDigestOptIn: true,
  onboardingCompleted: true,
};

async function setupPageAuth(page, { isPro = false, confirmed = true, onbDone = true } = {}) {
  // Set cookie for @supabase/ssr
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

  // Set localStorage items
  await page.evaluateOnNewDocument(
    (sess, prof, prefs, pro, isConfirmed, isOnbDone) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_user_email", prof.email);

      localStorage.setItem(
        "careermonke_entitlement_v2",
        JSON.stringify({
          isPro: pro,
          tier: pro ? "pro_monthly" : "free",
          status: pro ? "active" : "canceled",
          expiresAt: null,
          isDefinitive: true,
          cachedAt: Date.now(),
        })
      );

      if (pro) {
        localStorage.setItem("careermonke_pro_active", "true");
      } else {
        localStorage.removeItem("careermonke_pro_active");
      }

      if (isConfirmed) {
        localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
      } else {
        localStorage.removeItem("careermonke_candidate_profile");
      }

      localStorage.setItem(
        "careermonke_user_preferences",
        JSON.stringify({
          ...prefs,
          onboardingCompleted: isOnbDone,
        })
      );
    },
    sampleSession,
    sampleProfile,
    samplePreferences,
    isPro,
    confirmed,
    onbDone
  );
}

async function capture() {
  console.log("Starting screenshot capture for Onboarding, Processing Screen & Paywall...");

  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }

  // Create sample resume file
  const tempResumePath = path.resolve(process.cwd(), "temp-sample-resume.txt");
  fs.writeFileSync(
    tempResumePath,
    "Alex Candidate\nalex.candidate@careermonke.com\nSenior Full-Stack Engineer\n\nSkills: TypeScript, React, Node.js, PostgreSQL, Docker, AWS, Tailwind CSS\n\nExperience:\nTech Systems - Senior Full-Stack Developer (2021 - Present)\n- Architected scalable cloud services with React and Node.js\n- Optimized database query performance by 40%\n\nEducation:\nBS Computer Science, State University (2020)\n"
  );

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`Local static server listening at http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const viewports = [
    { name: "1440", width: 1440, height: 900 },
    { name: "360", width: 360, height: 780, isMobile: true },
  ];

  for (const vp of viewports) {
    console.log(`\nCapturing viewports for ${vp.name}px...`);

    // 1. Onboarding Screen (Step 1 Target Role)
    {
      const page = await browser.newPage();
      await page.setViewport(vp);
      await setupPageAuth(page, { isPro: false, confirmed: false, onbDone: false });
      await page.goto(`http://localhost:${PORT}/onboarding`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 800));

      const filename = `onboarding-step1-${vp.name}.png`;
      const reportPath = path.join(REPORT_DIR, filename);
      const artifactPath = path.join(ARTIFACT_DIR, filename);

      await page.screenshot({ path: reportPath, fullPage: false });
      fs.copyFileSync(reportPath, artifactPath);
      console.log(`Saved: ${filename}`);
      await page.close();
    }

    // 2. Onboarding Screen (Step 6 Upload Resume)
    {
      const page = await browser.newPage();
      await page.setViewport(vp);
      await setupPageAuth(page, { isPro: false, confirmed: false, onbDone: false });
      await page.goto(`http://localhost:${PORT}/onboarding`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 600));

      // Advance to step 6 (Upload Resume) by clicking Continue
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          const btn = btns.find((b) => b.textContent && b.textContent.includes("Continue"));
          if (btn) btn.click();
        });
        await new Promise((r) => setTimeout(r, 300));
      }

      const filename = `onboarding-upload-step-${vp.name}.png`;
      const reportPath = path.join(REPORT_DIR, filename);
      const artifactPath = path.join(ARTIFACT_DIR, filename);

      await page.screenshot({ path: reportPath, fullPage: false });
      fs.copyFileSync(reportPath, artifactPath);
      console.log(`Saved: ${filename}`);

      // 3. Trigger Resume Processing Stepper Screen
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.uploadFile(tempResumePath);
        // Wait 150ms for stepper UI to render before completion redirect
        await new Promise((r) => setTimeout(r, 150));

        const procFilename = `resume-processing-${vp.name}.png`;
        const procReportPath = path.join(REPORT_DIR, procFilename);
        const procArtifactPath = path.join(ARTIFACT_DIR, procFilename);

        try {
          await page.screenshot({ path: procReportPath, fullPage: false });
          fs.copyFileSync(procReportPath, procArtifactPath);
          console.log(`Saved: ${procFilename}`);
        } catch (e) {
          console.warn("Could not screenshot processing stepper:", e.message);
        }
      }

      await page.close();
    }

    // 4. Free User Dashboard (Blurred Top 10 + CTA Overlay)
    {
      const page = await browser.newPage();
      await page.setViewport(vp);
      await setupPageAuth(page, { isPro: false, confirmed: true, onbDone: true });
      await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 900));

      const filename = `dashboard-free-blurred-${vp.name}.png`;
      const reportPath = path.join(REPORT_DIR, filename);
      const artifactPath = path.join(ARTIFACT_DIR, filename);

      await page.screenshot({ path: reportPath, fullPage: false });
      fs.copyFileSync(reportPath, artifactPath);
      console.log(`Saved: ${filename}`);
      await page.close();
    }

    // 5. Pro User Dashboard (Unchanged, real Top 10 jobs)
    {
      const page = await browser.newPage();
      await page.setViewport(vp);
      await setupPageAuth(page, { isPro: true, confirmed: true, onbDone: true });
      await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 900));

      const filename = `dashboard-pro-active-${vp.name}.png`;
      const reportPath = path.join(REPORT_DIR, filename);
      const artifactPath = path.join(ARTIFACT_DIR, filename);

      await page.screenshot({ path: reportPath, fullPage: false });
      fs.copyFileSync(reportPath, artifactPath);
      console.log(`Saved: ${filename}`);
      await page.close();
    }
  }

  // Cleanup temp resume
  if (fs.existsSync(tempResumePath)) {
    fs.unlinkSync(tempResumePath);
  }

  await browser.close();
  server.close();
  console.log("\nAll screenshots captured and saved successfully!");
}

module.exports = { capture };

if (require.main === module) {
  capture().catch((err) => {
    console.error("Screenshot capture error:", err);
    process.exit(1);
  });
}
