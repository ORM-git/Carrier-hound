const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3506;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\c5deb1a1-59c2-4f16-b151-2ec9625c9084";
const REPORT_DIR = path.resolve(process.cwd(), "reports", "skill-what-if");

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

const sampleSimulation = {
  jobId: "sample",
  jobTitle: "Senior Distributed Systems Engineer",
  companyName: "Nexus Architecture Labs",
  baseMatch: 68,
  threshold: 75,
  missingSkills: [
    {
      id: "skill-k8s",
      name: "Kubernetes",
      matchGain: 12,
      category: "devops",
    },
    {
      id: "skill-ts",
      name: "TypeScript",
      matchGain: 9,
      category: "frontend",
    },
    {
      id: "skill-tf",
      name: "Terraform",
      matchGain: 8,
      category: "cloud",
    },
    {
      id: "skill-gql",
      name: "GraphQL",
      matchGain: 7,
      category: "backend",
    },
    {
      id: "skill-go",
      name: "Go (Golang)",
      matchGain: 10,
      category: "backend",
    },
    {
      id: "skill-otel",
      name: "OpenTelemetry",
      matchGain: 6,
      category: "architecture",
    },
  ],
  additionalJobs: [
    {
      id: "sim-job-1",
      title: "Cloud Infrastructure Architect",
      company: "Apex HyperScale Networks",
      baseMatch: 66,
      newMatch: 82,
      requiredSkills: ["Kubernetes", "Terraform"],
      country: "United States",
      workModel: "remote",
      salaryRange: "$165,000 - $195,000 / yr",
    },
    {
      id: "sim-job-2",
      title: "Backend Platform Engineer",
      company: "DataVanguard Systems",
      baseMatch: 69,
      newMatch: 85,
      requiredSkills: ["Go (Golang)", "Kubernetes"],
      country: "United Kingdom",
      workModel: "remote",
      salaryRange: "£90,000 - £110,000 / yr",
    },
    {
      id: "sim-job-3",
      title: "Principal Site Reliability Engineer",
      company: "Cortex Cloud Computing",
      baseMatch: 71,
      newMatch: 89,
      requiredSkills: ["Kubernetes", "OpenTelemetry"],
      country: "Germany",
      workModel: "remote",
    },
    {
      id: "sim-job-4",
      title: "Distributed Systems Core Engineer",
      company: "Helios Data Grid",
      baseMatch: 64,
      newMatch: 78,
      requiredSkills: ["Go (Golang)", "GraphQL"],
      country: "Worldwide",
      workModel: "remote",
      salaryRange: "$150,000 - $180,000 / yr",
    },
  ],
  skillsWorthLearning: [
    {
      id: "learn-1",
      name: "Kubernetes Orchestration",
      gainEstimate: "+18% market leverage",
      gainNumeric: 18,
      timeToLearn: "3-4 weeks",
    },
    {
      id: "learn-2",
      name: "Distributed Systems Architecture",
      gainEstimate: "+15% market leverage",
      gainNumeric: 15,
      timeToLearn: "4-6 weeks",
    },
    {
      id: "learn-3",
      name: "Terraform Infrastructure as Code",
      gainEstimate: "+12% market leverage",
      gainNumeric: 12,
    },
    {
      id: "learn-4",
      name: "Go (Golang) Microservices",
      gainEstimate: "+11% market leverage",
      gainNumeric: 11,
      timeToLearn: "2-3 weeks",
    },
  ],
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
    (sess, prof, sim) => {
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
      localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
      localStorage.setItem("careermonke_user_email", prof.email);
      localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
      localStorage.setItem(
        "careermonke_user_preferences",
        JSON.stringify({
          onboardingCompleted: true,
        })
      );

      // Intercept window.fetch for instant offline mocking of subscription check and simulation endpoint
      const originalFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);

        if (url.includes("/rest/v1/subscriptions")) {
          return new Response(
            JSON.stringify({
              id: "sub_mock_active_123",
              user_id: "usr_mock_123",
              status: "active",
              tier: "pro_monthly",
              plan: "pro",
              current_period_end: new Date(Date.now() + 86400000 * 365).toISOString(),
              created_at: new Date().toISOString(),
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        }

        if (url.includes("/api/jobs/skill-what-if")) {
          return new Response(
            JSON.stringify({
              simulation: sim,
              isPro: true,
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
              },
            }
          );
        }

        return originalFetch.apply(this, [input, init]);
      };
    },
    sampleSession,
    sampleProfile,
    sampleSimulation
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
    // 1. Desktop - 1440px Skill What-If View
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 1100 });
      await setupPageAuth(page);
      await page.goto(`http://localhost:${PORT}/jobs/sample/skill-what-if`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1200));

      const file1 = "skill-what-if-desktop-1440.png";
      await page.screenshot({ path: path.join(REPORT_DIR, file1), fullPage: true });
      if (fs.existsSync(ARTIFACT_DIR)) {
        fs.copyFileSync(path.join(REPORT_DIR, file1), path.join(ARTIFACT_DIR, file1));
      }
      console.log(`Captured ${file1}`);
      await page.close();
    }

    // 2. Mobile - 390px Skill What-If View
    {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
      await setupPageAuth(page);
      await page.goto(`http://localhost:${PORT}/jobs/sample/skill-what-if`, { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 1200));

      const file2 = "skill-what-if-mobile-390.png";
      await page.screenshot({ path: path.join(REPORT_DIR, file2), fullPage: true });
      if (fs.existsSync(ARTIFACT_DIR)) {
        fs.copyFileSync(path.join(REPORT_DIR, file2), path.join(ARTIFACT_DIR, file2));
      }
      console.log(`Captured ${file2}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

capture().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
