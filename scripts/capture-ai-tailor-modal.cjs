const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const ssr = require("@supabase/ssr");
const puppeteer = require("puppeteer-core");
const {
  PORT,
  CHROME_PATH,
  createServer,
} = require("./test-prompt5-base.cjs");

const REPORT_DIR = path.resolve(process.cwd(), "reports", "prompt-t1");
const SCREENSHOT_DIR = path.join(REPORT_DIR, "screenshots");
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\f124d0fc-3342-4fb1-b070-301ce6e60d8f";

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function getSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function getGitMetadata() {
  const headSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  const statusOutput = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
  const isDirty = statusOutput.length > 0;
  return { headSha, isDirty, statusOutput };
}

const validJwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfbW9ja18xMjMiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjE4OTM0NTYwMDB9.signature";

// Complete mock fixtures
const sampleSession = {
  access_token: validJwt,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1893456000,
  refresh_token: "mock_refresh_token",
  user: {
    id: "usr_mock_123",
    aud: "authenticated",
    role: "authenticated",
    email: "alex.candidate@careermonke.com",
    email_confirmed_at: new Date().toISOString(),
    user_metadata: { full_name: "Alex Candidate" },
  },
};

const sampleProfile = {
  userId: "usr_mock_123",
  name: "Alex Candidate",
  email: "alex.candidate@careermonke.com",
  phone: "+1 (555) 019-2834",
  location: "San Francisco, CA (Remote)",
  headline: "Staff Software Engineer - Infrastructure",
  summary: "Experienced backend and platform engineer specializing in distributed systems.",
  targetTitles: ["Staff Software Engineer", "Tech Lead"],
  topSkills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Tailwind CSS"],
  skills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Tailwind CSS", "Go", "Docker", "Kubernetes"],
  experience: [
    {
      id: "exp_1",
      company: "Stripe",
      role: "Staff Software Engineer",
      startDate: "2021",
      endDate: "Present",
      bullets: ["Architected multi-region database replication serving 50M daily transactions with high reliability."],
    },
  ],
  education: [{ id: "edu_1", degree: "B.S. Computer Science", institution: "Stanford University", year: "2019" }],
  certifications: ["AWS Certified Solutions Architect"],
  confirmedAt: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
};

const weakCandidateProfile = {
  userId: "usr_mock_123",
  name: "Alex Data",
  email: "alex@example.com",
  phone: "+1 (555) 018-9999",
  location: "Austin, TX (Remote)",
  headline: "Junior Data Analyst",
  summary: "Entry-level analyst focused on Excel spreadsheets and basic SQL data extraction.",
  skills: ["Excel", "SQL", "Tableau"],
  topSkills: ["Excel", "SQL"],
  experience: [
    {
      id: "exp_1",
      company: "Retail Corp",
      role: "Data Clerk",
      startDate: "2023",
      endDate: "Present",
      bullets: ["Queried SQL inventory tables and updated weekly Excel reports for 3 departments."],
    },
  ],
  education: [],
  certifications: [],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const samplePreferences = {
  roles: ["Staff Software Engineer", "Platform Engineer"],
  categories: ["Software Development", "DevOps & Cloud"],
  experience_level: "senior",
  experienceLevel: "senior",
  employment_types: ["full-time"],
  employmentTypes: ["full-time"],
  locations: ["Remote / Global"],
  remote_preference: "remote",
  remotePreference: "remote",
  work_auth: "Authorized",
  workAuth: "Authorized",
  min_salary: 160000,
  minSalary: 160000,
  salary_currency: "USD",
  salaryCurrency: "USD",
  daily_digest_opt_in: true,
  dailyDigestOptIn: true,
  onboarding_completed: true,
  onboardingCompleted: true,
  updated_at: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockJobs = [
  {
    id: "mock_job_1",
    source: "greenhouse",
    source_job_id: "gh_101",
    title: "Senior Full Stack Engineer",
    company: "Vercel",
    location: "Remote - US / Global",
    salary: "$165,000 - $195,000",
    salary_text: "$165,000 - $195,000",
    type: "Full-time",
    description: "Vercel is looking for a Senior Full Stack Engineer to lead developer experience features on Next.js. Requires experience with TypeScript, React, and Next.js platforms.",
    skills: ["TypeScript", "Next.js", "React"],
    apply_url: "https://example.com/apply/vercel-sr-fullstack",
    tags: ["React", "TypeScript", "Next.js"],
    date: new Date().toISOString(),
    postedAt: new Date().toISOString(),
    is_active: true,
  },
];

const mockDbJobs = mockJobs.map((j) => ({
  id: j.id,
  title: j.title,
  company_name: j.company,
  company: j.company,
  location: j.location,
  salary: j.salary,
  description: j.description,
  apply_url: j.apply_url,
  created_at: j.postedAt,
  posted_at: j.postedAt,
  is_active: true,
  status: "active",
  verified: true,
  remote: true,
  category: "engineering",
}));

// Setup capture mock routes
function setupCaptureMockRoutes(page, stateRef) {
  return page.on("request", (req) => {
    const url = req.url();
    const method = req.method();

    if (method === "OPTIONS") {
      req.respond({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
      return;
    }

    // Allow static server documents and Next.js assets
    if (url.startsWith(`http://localhost:${PORT}`) && !url.includes("/api/")) {
      req.continue();
      return;
    }

    // Mock API /ai
    if (url.includes("/api/ai")) {
      if (stateRef.simulateAiFailure) {
        req.respond({
          status: 502,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ error: "AI service generation failed. Please try again." }),
        });
        return;
      }

      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          success: true,
          model: "llama-3.3-70b-versatile",
          jobDescriptionShortened: false,
          result: {
            tailoredSummary: "Staff Software Engineer with deep expertise in distributed backend architecture, multi-region database replication, and high-performance cloud infrastructure.",
            highlightedSkills: ["TypeScript", "Next.js", "React", "PostgreSQL", "Docker", "Kubernetes"],
            tailoredBullets: {
              "exp_1": [
                "Architected multi-region database replication serving 50M daily transactions with high reliability.",
              ],
            },
          },
        }),
      });
      return;
    }

    // Mock Subscriptions
    if (url.includes("/subscriptions") || url.includes("/api/billing")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const subRow = {
        id: "sub_mock_active",
        user_id: "usr_mock_123",
        status: "active",
        plan: "pro_monthly",
        plan_id: "price_pro_monthly",
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        created_at: new Date().toISOString(),
      };
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isObjectExpected ? JSON.stringify(subRow) : JSON.stringify([subRow]),
      });
      return;
    }

    // Mock User Preferences
    if (url.includes("/user_preferences")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isObjectExpected ? JSON.stringify(samplePreferences) : JSON.stringify([samplePreferences]),
      });
      return;
    }

    // Mock Candidate Profiles
    if (url.includes("/candidate_profiles") || url.includes("/profiles")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const activeProf = stateRef.isWeakMatch ? weakCandidateProfile : sampleProfile;
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isObjectExpected ? JSON.stringify(activeProf) : JSON.stringify([activeProf]),
      });
      return;
    }

    // Mock Auth
    if (url.includes("/auth/v1/user")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify(sampleSession.user),
      });
      return;
    }

    if (url.includes("/auth/v1/token") || url.includes("/auth/v1/session")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify(sampleSession),
      });
      return;
    }

    if (url.includes("/auth/v1/otp")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      return;
    }

    // Mock Top 10 Jobs
    if (url.includes("/api/jobs/top10") || url.includes("/jobs/top10")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs: mockJobs.map((j) => ({
            job: j,
            diagnostics: {
              score: stateRef.isWeakMatch ? 42 : 85,
              scoreGrade: stateRef.isWeakMatch ? "low" : "high",
              matchedSkills: stateRef.isWeakMatch ? ["SQL"] : ["TypeScript", "Next.js", "React"],
              missingSkills: stateRef.isWeakMatch ? ["TypeScript", "Next.js", "React"] : [],
              breakdown: { skillScore: stateRef.isWeakMatch ? 30 : 85, titleScore: stateRef.isWeakMatch ? 20 : 88 },
            },
          })),
        }),
      });
      return;
    }

    // Mock Jobs
    if (url.includes("/rest/v1/jobs") || url.includes("jobs_public")) {
      const isSingle = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const matched = mockDbJobs.find((j) => url.includes(j.id)) || mockDbJobs[0];
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isSingle ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isSingle ? JSON.stringify(matched) : JSON.stringify(mockDbJobs),
      });
      return;
    }

    // Mock Tracker
    if (url.includes("/tracker") || url.includes("/applications")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify([]),
      });
      return;
    }

    // Mock Stats
    if (url.includes("/api/stats") || url.includes("/daily_digests") || url.includes("/api/radar")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ jobsToday: 124, totalJobs: 1250, companiesScanned: 380 }),
      });
      return;
    }

    try {
      req.abort("blockedbyclient");
    } catch {}
  });
}

async function configurePageAuthAndStorage(page, activeProfile) {
  await page.setRequestInterception(true);

  // Set authenticated cookies for Next.js SSR Supabase auth
  const cookieChunks = ssr.createChunks(
    "sb-szakevhxhwpeskidvtfs-auth-token",
    "base64-" + ssr.stringToBase64URL(JSON.stringify(sampleSession))
  );
  for (const c of cookieChunks) {
    await page.setCookie({
      name: c.name,
      value: c.value,
      domain: "localhost",
      path: "/",
    });
  }

  await page.setCookie({
    name: "careermonke_user_email",
    value: "alex.candidate@careermonke.com",
    domain: "localhost",
    path: "/",
  });

  // Seed cookie notice accepted, candidate profile, and preferences in localStorage
  await page.evaluateOnNewDocument(({ profile }) => {
    Object.keys(localStorage).forEach((k) => {
      if (k.startsWith("cm_tailored_resume_") || k.startsWith("careermonke_tailored_resume_")) localStorage.removeItem(k);
    });
    localStorage.setItem("cm_cookie_notice", "accepted");
    localStorage.setItem("careermonke_cookie_consent", "accepted");
    localStorage.setItem("careermonke_candidate_profile", JSON.stringify(profile));
    localStorage.setItem("careermonke_preferences", JSON.stringify({
      roles: ["Staff Software Engineer", "Platform Engineer"],
      categories: ["Software Development", "DevOps & Cloud"],
      experienceLevel: "senior",
      employmentTypes: ["full-time"],
      locations: ["Remote / Global"],
      remotePreference: "remote",
      workAuth: "Authorized",
      minSalary: 160000,
      salaryCurrency: "USD",
      dailyDigestOptIn: true,
      onboardingCompleted: true,
      updatedAt: new Date().toISOString(),
    }));
    localStorage.setItem("careermonke_user_email", "alex.candidate@careermonke.com");
    localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sampleSession));
  }, { profile: activeProfile });
}

async function captureTailorModalScreenshots() {
  console.log("================================================================================");
  console.log("CAREERMONKE T1 / T1c: CAPTURE AI RESUME TAILORING UI SCREENSHOTS");
  console.log("================================================================================\n");

  const gitMeta = getGitMetadata();
  console.log(`[GIT] Current commit SHA: ${gitMeta.headSha}`);
  console.log(`[GIT] Working tree dirty: ${gitMeta.isDirty ? "YES (local uncommitted edits)" : "CLEAN"}`);
  if (gitMeta.isDirty) {
    console.log(`[GIT] Modified files:\n${gitMeta.statusOutput}`);
  }

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`\n[SERVER] Static server listening on port ${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
    ],
  });

  const manifest = [];

  try {
    // =========================================================================
    // PART 1: Standard Candidate (alex.candidate) Flow
    // =========================================================================
    const stateRef = { simulateAiFailure: false, isWeakMatch: false };
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    setupCaptureMockRoutes(page, stateRef);
    await configurePageAuthAndStorage(page, sampleProfile);

    console.log("[NAV] Navigating to /dashboard...");
    await page.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));

    // Wait for "AI Resume" button in Top 10 jobs
    await page.waitForSelector("button", { timeout: 10000 });

    console.log("[ACTION] Finding and clicking 'AI Resume' button...");
    const opened = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const aiBtn = btns.find((b) => b.textContent && b.textContent.includes("AI Resume"));
      if (aiBtn) {
        aiBtn.click();
        return true;
      }
      return false;
    });

    if (!opened) {
      throw new Error("Could not find 'AI Resume' button on dashboard");
    }

    await new Promise((r) => setTimeout(r, 1200));
    await page.waitForSelector('button[aria-label="Close modal"]', { timeout: 8000 });

    // -------------------------------------------------------------
    // CAPTURE 1: Rules-based Default State (ATS keyword match estimate)
    // -------------------------------------------------------------
    console.log("[CAPTURE 1] Capturing ai_tailor_rules_state.png...");
    const path1 = path.join(SCREENSHOT_DIR, "ai_tailor_rules_state.png");
    await page.screenshot({ path: path1, fullPage: false });

    // -------------------------------------------------------------
    // CAPTURE 2: Click "Generate AI-tailored version" -> Review State
    // -------------------------------------------------------------
    console.log("[ACTION] Clicking 'Generate AI-tailored version' button...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const genBtn = btns.find((b) => b.textContent && b.textContent.includes("Generate AI-tailored version"));
      if (genBtn) genBtn.click();
    });

    await new Promise((r) => setTimeout(r, 1800));

    console.log("[CAPTURE 2] Capturing ai_tailor_review_state.png...");
    const path2 = path.join(SCREENSHOT_DIR, "ai_tailor_review_state.png");
    await page.screenshot({ path: path2, fullPage: false });

    // -------------------------------------------------------------
    // CAPTURE 3: Click "Accept AI Changes" -> Accepted State
    // -------------------------------------------------------------
    console.log("[ACTION] Clicking 'Accept AI Changes' button...");
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const acceptBtn = btns.find((b) => b.textContent && b.textContent.includes("Accept AI Changes"));
      if (acceptBtn) acceptBtn.click();
    });

    await new Promise((r) => setTimeout(r, 1200));

    console.log("[CAPTURE 3] Capturing ai_tailor_accepted_state.png...");
    const path3 = path.join(SCREENSHOT_DIR, "ai_tailor_accepted_state.png");
    await page.screenshot({ path: path3, fullPage: false });

    // -------------------------------------------------------------
    // CAPTURE 4: Re-generate with failure -> Failed State
    // -------------------------------------------------------------
    console.log("[ACTION] Triggering simulated AI failure...");
    stateRef.simulateAiFailure = true;

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const regenBtn = btns.find((b) => b.textContent && (b.textContent.includes("Re-generate AI") || b.textContent.includes("Generate AI-tailored version")));
      if (regenBtn) regenBtn.click();
    });

    await new Promise((r) => setTimeout(r, 1500));

    console.log("[CAPTURE 4] Capturing ai_tailor_failed_state.png...");
    const path4 = path.join(SCREENSHOT_DIR, "ai_tailor_failed_state.png");
    await page.screenshot({ path: path4, fullPage: false });

    await page.close();

    // =========================================================================
    // PART 2: Weak Match Candidate (< 85 Score) Isolated Flow
    // =========================================================================
    console.log("\n[ACTION] Launching isolated page for weak match candidate (< 85 score)...");
    const weakContext = await browser.createBrowserContext();
    const pageWeak = await weakContext.newPage();
    const stateWeak = { simulateAiFailure: false, isWeakMatch: true };
    await pageWeak.setViewport({ width: 1280, height: 900 });
    setupCaptureMockRoutes(pageWeak, stateWeak);
    await configurePageAuthAndStorage(pageWeak, weakCandidateProfile);

    await pageWeak.goto(`http://localhost:${PORT}/dashboard`, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));

    await pageWeak.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const aiBtn = btns.find((b) => b.textContent && b.textContent.includes("AI Resume"));
      if (aiBtn) aiBtn.click();
    });
    await new Promise((r) => setTimeout(r, 1200));
    await pageWeak.waitForSelector('button[aria-label="Close modal"]', { timeout: 8000 });

    console.log("[CAPTURE 5] Capturing ai_tailor_weak_match_state.png...");
    const path5 = path.join(SCREENSHOT_DIR, "ai_tailor_weak_match_state.png");
    await pageWeak.screenshot({ path: path5, fullPage: false });

    await pageWeak.close();
    await weakContext.close();

    // Copy to artifact directory
    const shots = [
      { name: "ai_tailor_rules_state.png", file: path1 },
      { name: "ai_tailor_review_state.png", file: path2 },
      { name: "ai_tailor_accepted_state.png", file: path3 },
      { name: "ai_tailor_failed_state.png", file: path4 },
      { name: "ai_tailor_weak_match_state.png", file: path5 },
    ];

    for (const s of shots) {
      if (fs.existsSync(s.file)) {
        const dest = path.join(ARTIFACT_DIR, s.name);
        fs.copyFileSync(s.file, dest);
        const stat = fs.statSync(s.file);
        const hash = getSha256(s.file);
        manifest.push({
          name: s.name,
          path: s.file,
          artifactPath: dest,
          bytes: stat.size,
          sha256: hash,
        });
      }
    }

    console.log("\n================================================================================");
    console.log("SCREENSHOT CAPTURE MANIFEST:");
    console.log(`Git HEAD Commit: ${gitMeta.headSha} (${gitMeta.isDirty ? "DIRTY" : "CLEAN"})`);
    manifest.forEach((m) => {
      console.log(`  - ${m.name}: ${m.bytes} bytes | SHA256: ${m.sha256}`);
    });
    console.log("================================================================================");
  } finally {
    await browser.close();
    server.close();
  }
}

captureTailorModalScreenshots().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
