const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const ssr = require("@supabase/ssr");

const PORT = 3591;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "prompt5");

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

const validJwt =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfbW9ja18xMjMiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJleHAiOjE4OTM0NTYwMDB9.signature";

const sampleSession = {
  access_token: validJwt,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 1893456000,
  refresh_token: "mock-refresh-token",
  user: {
    id: "usr_mock_123",
    aud: "authenticated",
    role: "authenticated",
    email: "alex.candidate@careermonke.com",
    email_confirmed_at: new Date().toISOString(),
    user_metadata: {
      full_name: "Alex Candidate",
    },
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
      bullets: ["Architected multi-region database replication serving 50M daily transactions."],
    },
  ],
  education: [
    {
      id: "edu_1",
      degree: "B.S. Computer Science",
      institution: "Stanford University",
      year: "2019",
    },
  ],
  certifications: ["AWS Certified Solutions Architect"],
  confirmedAt: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
  updatedAt: new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString(),
};

const samplePreferences = {
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
};

const JOB_1_UUID = "11111111-1111-4111-8111-111111111111";
const JOB_2_UUID = "22222222-2222-4222-8222-222222222222";
const JOB_3_UUID = "33333333-3333-4333-8333-333333333333";
const APP_1_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const mockJobs = [
  {
    id: JOB_1_UUID,
    legacy_id: "mock_job_1",
    source: "greenhouse",
    source_job_id: "gh_101",
    title: "Senior Full Stack Engineer",
    company: "Vercel",
    location: "Remote - US / Global",
    salary: "$165,000 - $195,000",
    salary_text: "$165,000 - $195,000",
    type: "Full-time",
    description: "Vercel is looking for a Senior Full Stack Engineer to lead developer experience features on Next.js.",
    requirements: "5+ years TypeScript, React, Next.js, and serverless architectures.",
    apply_url: "https://example.com/apply/vercel-senior-fullstack",
    tags: ["React", "TypeScript", "Next.js"],
    date: new Date().toISOString(),
    postedAt: new Date().toISOString(),
    is_active: true,
  },
  {
    id: JOB_2_UUID,
    legacy_id: "mock_job_2",
    source: "lever",
    source_job_id: "lev_202",
    title: "Staff Distributed Systems Engineer",
    company: "Supabase",
    location: "Remote - Worldwide",
    salary: "$180,000 - $220,000",
    salary_text: "$180,000 - $220,000",
    type: "Full-time",
    description: "Scale open-source PostgreSQL clustering, realtime websocket engines, and Auth.",
    requirements: "PostgreSQL, Go, Rust, and distributed consensus.",
    apply_url: "https://example.com/apply/supabase-staff-dist-sys",
    tags: ["PostgreSQL", "Go", "Distributed Systems"],
    date: new Date().toISOString(),
    postedAt: new Date().toISOString(),
    is_active: true,
  },
  {
    id: JOB_3_UUID,
    legacy_id: "mock_job_3",
    source: "greenhouse",
    source_job_id: "gh_103",
    title: "Senior Full Stack Engineer",
    company: "Vercel",
    location: "Remote - EMEA",
    salary: "$165,000 - $195,000",
    salary_text: "$165,000 - $195,000",
    type: "Full-time",
    description: "Vercel EMEA team is looking for a Senior Full Stack Engineer with Next.js expertise.",
    requirements: "5+ years TypeScript, React, Next.js.",
    apply_url: "https://example.com/apply/vercel-emea-fullstack",
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

async function setupPageMocks(page, options = {}) {
  const { isSigned = true, isPro = true, cookieNotice = false, initialApplications } = options;

  // Isolated per-page record store modeling real record IDs, user/job matching, notes, and stages
  const applicationsStore = (initialApplications
    ? initialApplications
    : [
        {
          id: APP_1_UUID,
          job_id: JOB_1_UUID,
          title: "Senior Full Stack Engineer",
          company: "Vercel",
          stage: "saved",
          notes: "Follow up next week",
          location: "Remote",
          salary_text: "$165k - $195k",
          applied_at: null,
          created_at: new Date(Date.now() - 86400000).toISOString(),
          updated_at: new Date(Date.now() - 86400000).toISOString(),
        },
      ]
  ).map((r) => ({ ...r }));

  page._testApplicationsStore = applicationsStore;

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();

    // Allow local document navigation and static assets to load normally
    if (url.startsWith("http://localhost:") && !url.includes("/api/")) {
      req.continue();
      return;
    }
    // If it's a Supabase/PostgREST/Stripe API request, we intercept and mock it below.
    // If unhandled and external, abort immediately to deny external network traffic.
    const isKnownApi =
      url.includes("/subscriptions") ||
      url.includes("/candidate_profiles") ||
      url.includes("/profiles") ||
      url.includes("/tracker") ||
      url.includes("/applications") ||
      url.includes("/user_preferences") ||
      url.includes("/jobs") ||
      url.includes("/api/account/delete") ||
      url.includes("/api/radar") ||
      url.includes("/api/stats") ||
      url.includes("/api/jobs/top10") ||
      url.includes("/api/jobs/search") ||
      url.includes("/daily_digests") ||
      url.includes("/auth/v1");

    if (!isKnownApi) {
      req.abort("blockedbyclient");
      return;
    }

    if (req.method() === "OPTIONS") {
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

    if (url.includes("/subscriptions") || url.includes("/api/billing")) {
      if (req.method() === "PATCH") {
        req.respond({
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
          },
          body: JSON.stringify([{ id: "sub_mock_active", status: "canceled", cancel_at_period_end: true }]),
        });
        return;
      }
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const subRow = {
        id: "sub_mock_active",
        user_id: "usr_mock_123",
        status: isPro ? "active" : "canceled",
        plan: "pro_monthly",
        plan_id: "price_pro_monthly",
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        created_at: new Date().toISOString(),
      };
      const body = (isSigned && isPro)
        ? isObjectExpected ? JSON.stringify(subRow) : JSON.stringify([subRow])
        : isObjectExpected ? "null" : JSON.stringify([]);

      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body,
      });
      return;
    }

    if (url.includes("/user_preferences")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const prefRow = {
        user_id: "usr_mock_123",
        roles: ["Staff Software Engineer", "Platform Engineer"],
        categories: ["Software Development", "DevOps & Cloud"],
        experience_level: "senior",
        employment_types: ["full-time"],
        locations: ["Remote / Global"],
        remote_preference: "remote",
        work_auth: "Authorized",
        min_salary: 160000,
        salary_currency: "USD",
        daily_digest_opt_in: true,
        onboarding_completed: true,
        updated_at: new Date().toISOString(),
      };
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isSigned
          ? (isObjectExpected ? JSON.stringify(prefRow) : JSON.stringify([prefRow]))
          : (isObjectExpected ? "null" : JSON.stringify([])),
      });
      return;
    }

    if (url.includes("/candidate_profiles") || url.includes("/profiles")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isSigned
          ? (isObjectExpected ? JSON.stringify(sampleProfile) : JSON.stringify([sampleProfile]))
          : (isObjectExpected ? "null" : JSON.stringify([])),
      });
      return;
    }

    if (url.includes("/api/account/delete")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ success: true, message: "Account deleted successfully in mock" }),
      });
      return;
    }

    if (url.includes("/auth/v1/user")) {
      if (!isSigned) {
        req.respond({
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Invalid JWT: user not authenticated", error: "unauthorized" }),
        });
        return;
      }
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify(sampleSession.user),
      });
      return;
    }

    if (url.includes("/auth/v1/token")) {
      if (!isSigned) {
        req.respond({
          status: 401,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "Invalid JWT: user not authenticated", error: "unauthorized" }),
        });
        return;
      }
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

    if (url.includes("/daily_digests")) {
      const isObjectExpected = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      req.respond({
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": isObjectExpected ? "application/vnd.pgrst.object+json" : "application/json",
        },
        body: isObjectExpected ? "null" : JSON.stringify([]),
      });
      return;
    }

    if (url.includes("/tracker") || url.includes("/applications")) {
      if (req.method() === "POST") {
        let rawParsed = {};
        try {
          rawParsed = JSON.parse(req.postData() || "{}");
        } catch {}
        const parsed = Array.isArray(rawParsed) ? (rawParsed[0] || {}) : rawParsed;

        // Match existing record: when both have job_id, match by job_id only; never merge different known IDs
        const existingIdx = applicationsStore.findIndex((a) => {
          if (parsed.id && a.id === parsed.id) return true;
          const aJobId = (a.job_id || a.jobId || "").trim();
          const pJobId = (parsed.job_id || parsed.jobId || "").trim();
          if (aJobId && pJobId) {
            return aJobId === pJobId;
          }
          if (a.company && parsed.company && a.title && parsed.title) {
            return (
              a.company.trim().toLowerCase() === parsed.company.trim().toLowerCase() &&
              a.title.trim().toLowerCase() === parsed.title.trim().toLowerCase()
            );
          }
          return false;
        });

        let savedRecord;
        if (existingIdx >= 0) {
          applicationsStore[existingIdx] = {
            ...applicationsStore[existingIdx],
            ...parsed,
            job_id: applicationsStore[existingIdx].job_id || parsed.job_id,
            // Preserve existing notes if not explicitly provided
            notes:
              parsed.notes !== undefined && parsed.notes !== null
                ? parsed.notes
                : applicationsStore[existingIdx].notes,
            updated_at: new Date().toISOString(),
          };
          savedRecord = applicationsStore[existingIdx];
        } else {
          savedRecord = {
            id: parsed.id || "11111111-2222-4333-8444-555555555555",
            job_id: parsed.job_id || JOB_1_UUID,
            title: parsed.title || "Job Title",
            company: parsed.company || "Company",
            stage: parsed.stage || "saved",
            notes: parsed.notes || "",
            location: parsed.location || "Remote",
            salary_text: parsed.salary_text || null,
            apply_url: parsed.apply_url || null,
            applied_at: parsed.applied_at || (parsed.stage === "applied" ? new Date().toISOString() : null),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          applicationsStore.push(savedRecord);
        }

        req.respond({
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify([savedRecord]),
        });
        return;
      }

      if (req.method() === "PATCH") {
        let rawParsed = {};
        try {
          rawParsed = JSON.parse(req.postData() || "{}");
        } catch {}
        const parsed = Array.isArray(rawParsed) ? (rawParsed[0] || {}) : rawParsed;

        // Match target by query parameter or body id
        const idMatch = url.match(/[?&]id=eq\.([a-zA-Z0-9_-]+)/);
        const targetId = idMatch ? idMatch[1] : parsed.id;

        const target = targetId
          ? applicationsStore.find((a) => a.id === targetId)
          : applicationsStore[0];

        if (target) {
          if (parsed.stage) target.stage = parsed.stage;
          if (parsed.applied_at !== undefined) target.applied_at = parsed.applied_at;
          if (parsed.notes !== undefined) target.notes = parsed.notes;
          target.updated_at = new Date().toISOString();
        }

        req.respond({
          status: 200,
          headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify(target ? [target] : []),
        });
        return;
      }

      // GET
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: isSigned ? JSON.stringify(applicationsStore) : JSON.stringify([]),
      });
      return;
    }

    if (url.includes("/api/stats")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          jobsToday: 124,
          totalJobs: 1250,
          companiesScanned: 380,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }

    if (url.includes("/api/jobs/top10")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs: mockJobs.map((j) => ({
            job: j,
            diagnostics: {
              score: 95,
              scoreGrade: "high",
              matchedSkills: ["TypeScript", "Next.js", "React"],
              missingSkills: [],
              inferredSignals: ["Frontend Architecture"],
              whyYouFit: ["Strong alignment with React and Next.js stack"],
              gaps: [],
              jobRequiredSkills: ["TypeScript", "Next.js", "React"],
              breakdown: {
                skillScore: 95,
                titleScore: 98,
                experienceScore: 92,
                remoteScore: 100,
                yearsOfExperience: 6,
              },
            },
          })),
        }),
      });
      return;
    }

    if (url.includes("/rest/v1/jobs") || url.includes("jobs_public")) {
      const isSingle = (req.headers()["accept"] || "").includes("vnd.pgrst.object+json");
      const matched = mockDbJobs.find((j) => url.includes(j.id) || (j.legacy_id && url.includes(j.legacy_id))) || mockDbJobs[0];
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

    if (url.includes("/api/jobs/pro")) {
      const matched = mockJobs.find((j) => url.includes(j.id) || (j.legacy_id && url.includes(j.legacy_id))) || mockJobs[0];
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          job: {
            id: matched.id,
            title: matched.title,
            company: matched.company,
            company_name: matched.company,
            location: matched.location,
            salary: matched.salary,
            salary_text: matched.salary_text,
            description: matched.description,
            requirements: matched.requirements,
            apply_url: matched.apply_url,
            is_active: true,
            status: "active",
            verified: true,
            remote: true,
          },
        }),
      });
      return;
    }

    if (url.includes("/api/jobs")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          jobs: mockJobs,
          total: 2,
          page: 1,
          pageSize: 20,
        }),
      });
      return;
    }

    if (url.includes("/api/radar")) {
      req.respond({
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          header: {
            totalActive: 1250,
            totalVerified: 1100,
            dataAsOf: new Date().toISOString(),
          },
          cities: [
            { id: "sf", name: "San Francisco", countryCode: "US", region: "americas", coordinates: [-122.4194, 37.7749], totalCount: 420, verifiedCount: 380, topCompanies: ["Stripe", "OpenAI"] },
            { id: "london", name: "London", countryCode: "GB", region: "europe", coordinates: [-0.1278, 51.5074], totalCount: 210, verifiedCount: 195, topCompanies: ["DeepMind", "Revolut"] },
          ],
          countries: {
            US: { name: "United States", total: 420, verified: 380, coordinates: [-95.7129, 37.0902] },
            GB: { name: "United Kingdom", total: 210, verified: 195, coordinates: [-3.4360, 55.3781] },
          },
          worldwideRemote: { id: "ww-remote", name: "Worldwide Remote", totalCount: 500, verifiedCount: 450, topCompanies: ["GitLab", "Automattic"] },
          unlocated: { totalCount: 50, verifiedCount: 40 },
        }),
      });
      return;
    }

    // Local static asset
    req.continue();
  });

  if (isSigned) {
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

    await page.evaluateOnNewDocument(
      ({ profile, cookieNotice, initialApps }) => {
        try {
          const isReload =
            Boolean(window.performance && window.performance.getEntriesByType && window.performance.getEntriesByType("navigation")[0]?.type === "reload") ||
            sessionStorage.getItem("__test_page_initialized") === "true";

          if (!isReload) {
            sessionStorage.setItem("__test_page_initialized", "true");
            localStorage.clear();
            localStorage.setItem("careermonke_candidate_profile", JSON.stringify(profile));
            localStorage.setItem("careermonke_user_email", "alex.candidate@careermonke.com");
            if (initialApps && initialApps.length > 0) {
              const scopedPayload = JSON.stringify(
                initialApps.map((a) => ({
                  id: a.id,
                  jobId: a.job_id || a.jobId,
                  title: a.title,
                  company: a.company,
                  stage: a.stage,
                  notes: a.notes,
                  location: a.location,
                  salaryText: a.salary_text || a.salaryText,
                  appliedAt: a.applied_at || a.appliedAt,
                  createdAt: a.created_at || a.createdAt,
                  updatedAt: a.updated_at || a.updatedAt,
                }))
              );
              localStorage.setItem("careermonke_applications_usr_mock_123", scopedPayload);
            } else {
              localStorage.removeItem("careermonke_applications_usr_mock_123");
            }
          }
          localStorage.setItem(
            "careermonke_preferences",
            JSON.stringify({
              roles: ["Full Stack Engineer", "Staff Engineer"],
              categories: ["engineering"],
              experienceLevel: "senior",
              employmentTypes: ["full-time"],
              locations: ["Remote"],
              remotePreference: "remote_only",
              workAuth: "authorized",
              minSalary: 150000,
              salaryCurrency: "USD",
              dailyDigestOptIn: true,
              onboardingCompleted: true,
              updatedAt: new Date().toISOString(),
            })
          );
          if (!cookieNotice) {
            localStorage.setItem("careermonke_cookie_consent", "accepted");
          } else {
            localStorage.removeItem("careermonke_cookie_consent");
          }
        } catch {}
      },
      { profile: sampleProfile, cookieNotice, initialApps: applicationsStore }
    );
  } else {
    // Guest / unauthenticated state: clear cookies and local storage
    try {
      const client = await page.target().createCDPSession();
      await client.send("Network.clearBrowserCookies");
      await client.send("Network.clearBrowserCache");
    } catch {}
    const existingCookies = await page.cookies();
    for (const c of existingCookies) {
      await page.deleteCookie(c);
    }
    await page.evaluateOnNewDocument(({ cookieNotice }) => {
      try {
        localStorage.clear();
        sessionStorage.clear();
        if (!cookieNotice) {
          localStorage.setItem("careermonke_cookie_consent", "accepted");
        }
      } catch {}
    }, { cookieNotice });
  }
}

// WCAG relative luminance & contrast calculation
function getLuminance(r, g, b) {
  const a = [r, g, b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function parseRgb(colorStr) {
  const m = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function getContrastRatio(rgb1, rgb2) {
  const lum1 = getLuminance(rgb1[0], rgb1[1], rgb1[2]);
  const lum2 = getLuminance(rgb2[0], rgb2[1], rgb2[2]);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

module.exports = {
  PORT,
  OUT_DIR,
  CHROME_PATH,
  REPORT_DIR,
  createServer,
  setupPageMocks,
  getLuminance,
  parseRgb,
  getContrastRatio,
};
