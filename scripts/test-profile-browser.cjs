const http = require("http");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const PORT = 3457;
const OUT_DIR = path.resolve(process.cwd(), "out");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

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

const sampleUser = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  email: "alex.morgan@example.com",
  user_metadata: { full_name: "Alex Morgan" },
  aud: "authenticated",
  role: "authenticated",
};

const sampleSession = {
  access_token: "mock-token",
  refresh_token: "mock-refresh",
  expires_in: 3600,
  token_type: "bearer",
  user: sampleUser,
};

const sampleProfile = {
  name: "Alex Morgan",
  email: "alex.morgan@example.com",
  phone: "+1 (415) 555-0199",
  location: "San Francisco, CA (Remote)",
  headline: "Staff Full-Stack Engineer & Distributed Systems Architect",
  summary:
    "Staff Engineer with 9+ years building high-throughput distributed systems, event-driven backends, and responsive Next.js web applications.",
  skills: [
    "TypeScript",
    "React",
    "Next.js",
    "Node.js",
    "PostgreSQL",
    "Go",
    "Docker",
    "Kubernetes",
    "Redis",
    "GraphQL",
  ],
  experience: [
    {
      id: "exp-1",
      company: "Apex Cloud Technologies",
      role: "Staff Infrastructure Engineer",
      startDate: "2023",
      endDate: "Present",
      location: "San Francisco, CA",
      bullets: [
        "Architected event-driven microservices processing 45M daily webhooks with 99.99% uptime.",
      ],
    },
    {
      id: "exp-2",
      company: "HyperScale Labs",
      role: "Senior Full-Stack Engineer",
      startDate: "2020",
      endDate: "2023",
      location: "Remote",
      bullets: [
        "Led migration of monolith dashboard into modular Next.js App Router frontends.",
      ],
    },
  ],
  education: [
    {
      id: "edu-1",
      degree: "B.S. in Computer Science",
      institution: "University of California, Berkeley",
      year: "2019",
      fieldOfStudy: "Computer Systems & Networking",
    },
  ],
  certifications: ["AWS Certified Solutions Architect - Professional"],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function runBrowserChecks() {
  console.log("==================================================================================");
  console.log("     AUTOMATED BROWSER CHECKS: PROFILE SCROLL-SPY, HEADER UPDATE & DRAWERS        ");
  console.log("==================================================================================\n");

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[PASS] Mock static server listening on http://localhost:${PORT}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();
    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

    // Set cookies
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

    // Bootstrap localStorage with isolated candidate profile
    await page.evaluateOnNewDocument(
      (sess, prof) => {
        localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
        localStorage.setItem("careermonke_auth_user", JSON.stringify(sess.user));
        localStorage.setItem("careermonke_candidate_profile", JSON.stringify(prof));
        localStorage.setItem("careermonke_user_email", prof.email);
        localStorage.setItem("careermonke_pro_active", "true");
      },
      sampleSession,
      sampleProfile
    );

    // -----------------------------------------------------------------------
    // CHECK 1: Desktop Layout & Drawer 808px Dimension Check
    // -----------------------------------------------------------------------
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://localhost:${PORT}/profile`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[data-testid="profile-header-card"]', { timeout: 10000 });
    console.log("  [PASS] Page initialized: Profile loaded on desktop viewport 1280x900");

    // Open personal drawer
    const editBtn = await page.$('[data-testid="edit-header-btn"]');
    if (!editBtn) throw new Error("Edit header button not found");
    await editBtn.click();
    await page.waitForSelector('[data-testid="profile-drawer-personal"]', { timeout: 5000 });

    const initialName = await page.$eval('input#field-name', el => el.value);
    console.log(`  [INFO] Initial input#field-name value when drawer opened: "${initialName}"`);

    const desktopDrawerBox = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="profile-drawer-personal"] > div.relative');
      if (!drawer) return null;
      const rect = drawer.getBoundingClientRect();
      return { width: rect.width, right: rect.right };
    });

    if (!desktopDrawerBox || desktopDrawerBox.width !== 808) {
      console.warn(`  [INFO] Desktop drawer width measured: ${desktopDrawerBox?.width}px (target: 808px)`);
      if (!desktopDrawerBox || desktopDrawerBox.width < 800 || desktopDrawerBox.width > 815) {
        throw new Error(`Drawer width expected ~808px, got ${desktopDrawerBox?.width}`);
      }
    }
    console.log(`  [PASS] Desktop drawer width verified: ${desktopDrawerBox.width}px`);

    // -----------------------------------------------------------------------
    // CHECK 2: Header UPDATE Button & Required Validation Check
    // -----------------------------------------------------------------------
    const headerUpdateBtn = await page.$('[data-testid="drawer-header-update-btn"]');
    if (!headerUpdateBtn) throw new Error("Header UPDATE button not found!");
    const btnText = await page.evaluate(el => el.textContent.trim(), headerUpdateBtn);
    if (!btnText.includes("UPDATE")) throw new Error(`Expected button text to include UPDATE, got: ${btnText}`);
    console.log(`  [PASS] Header UPDATE action present with text: "${btnText}"`);

    // Clear name input to test required validation
    const nameInput = await page.$('input#field-name');
    if (!nameInput) throw new Error("Full Name input not found");
    await nameInput.focus();
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");

    // Also trigger input event to ensure React state updates
    await page.evaluate(() => {
      const input = document.querySelector('input#field-name');
      if (input) {
        input.value = "";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });

    const clearedVal = await page.$eval('input#field-name', el => el.value);
    console.log(`  [INFO] Value after clearing: "${clearedVal}"`);

    // Click Header UPDATE
    await headerUpdateBtn.click();
    await page.waitForSelector('[data-testid="drawer-error-alert"]', { timeout: 3000 });
    const validationError = await page.evaluate(() => {
      const alert = document.querySelector('[data-testid="drawer-error-alert"]');
      return alert ? alert.textContent : "";
    });
    if (!validationError.includes("Full Name is required.")) {
      throw new Error(`Expected validation error 'Full Name is required.', got: ${validationError}`);
    }
    console.log(`  [PASS] Header UPDATE validation triggered: "${validationError.trim()}"`);

    // -----------------------------------------------------------------------
    // CHECK 3: Simulated Save Failure - Error Banner & Draft Preservation
    // -----------------------------------------------------------------------
    // Set a valid draft name
    await nameInput.type("Alex Morgan Draft Edit");

    // Inject mock failure into candidate profile save in window
    await page.evaluate(() => {
      window.__MOCK_PROFILE_SAVE_ERROR__ = "Simulated backend database network error.";
    });

    // Click Header UPDATE with failing mock
    await headerUpdateBtn.click();
    await page.waitForSelector('[data-testid="drawer-error-alert"]', { timeout: 3000 });

    // Verify error banner is shown
    const simulatedErrorText = await page.evaluate(() => {
      const alert = document.querySelector('[data-testid="drawer-error-alert"]');
      return alert ? alert.textContent : "";
    });
    if (!simulatedErrorText.includes("Simulated backend database network error")) {
      throw new Error(`Expected simulated error banner, got: "${simulatedErrorText}"`);
    }

    // Verify draft input value is still preserved
    const currentNameVal = await page.evaluate(el => el.value, nameInput);
    if (currentNameVal !== "Alex Morgan Draft Edit") {
      throw new Error(`Draft edits lost on failure! Expected 'Alex Morgan Draft Edit', got: '${currentNameVal}'`);
    }
    console.log("  [PASS] Simulated save failure correctly caught: Draft preserved & error banner displayed");

    // Remove mock failure
    await page.evaluate(() => {
      delete window.__MOCK_PROFILE_SAVE_ERROR__;
    });

    // -----------------------------------------------------------------------
    // CHECK 4: Cancel / Escape Key Discards Unsaved Edits
    // -----------------------------------------------------------------------
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));

    // Ensure drawer is closed
    const drawerStillOpen = await page.$('[data-testid="profile-drawer-personal"]');
    if (drawerStillOpen) throw new Error("Drawer did not close on Escape key press");
    console.log("  [PASS] Escape key dismissed drawer cleanly");

    // Re-open personal drawer to verify original persisted data was restored and draft discarded
    await editBtn.click();
    await page.waitForSelector('[data-testid="profile-drawer-personal"]', { timeout: 5000 });
    const reOpenedName = await page.$eval('input#field-name', el => el.value);
    if (reOpenedName !== "Alex Morgan") {
      throw new Error(`Expected draft to be discarded, but got: '${reOpenedName}'`);
    }
    console.log(`  [PASS] Draft discarded on cancel: Restored original '${reOpenedName}'`);

    // Close drawer via cancel button
    const cancelBtn = await page.$('[data-testid="drawer-cancel-btn"]');
    if (cancelBtn) await cancelBtn.click();
    await new Promise((r) => setTimeout(r, 400));

    // -----------------------------------------------------------------------
    // CHECK 5: Mobile Viewport Full-Screen Drawer
    // -----------------------------------------------------------------------
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await new Promise((r) => setTimeout(r, 300));
    const mobileEditBtn = await page.$('[data-testid="edit-header-btn"]');
    if (!mobileEditBtn) throw new Error("Mobile edit button not found");
    await mobileEditBtn.click();
    await page.waitForSelector('[data-testid="profile-drawer-personal"]', { timeout: 5000 });

    const mobileDrawerBox = await page.evaluate(() => {
      const drawer = document.querySelector('[data-testid="profile-drawer-personal"] > div.relative');
      if (!drawer) return null;
      const rect = drawer.getBoundingClientRect();
      return { width: rect.width };
    });
    if (!mobileDrawerBox || mobileDrawerBox.width !== 390) {
      throw new Error(`Mobile drawer expected width 390px, got: ${mobileDrawerBox?.width}`);
    }
    console.log(`  [PASS] Mobile drawer verified full-screen: ${mobileDrawerBox.width}px`);

    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 400));

    // -----------------------------------------------------------------------
    // CHECK 6: Click-to-Scroll & Scroll-Spy Tab Tracking
    // -----------------------------------------------------------------------
    await page.setViewport({ width: 1280, height: 900 });
    await new Promise((r) => setTimeout(r, 300));

    // Check initial active tab is "Personal"
    const initialActiveTab = await page.evaluate(() => {
      const activeBtn = document.querySelector('button[role="tab"][aria-selected="true"]');
      return activeBtn ? activeBtn.textContent.trim() : null;
    });
    if (initialActiveTab !== "Personal") {
      throw new Error(`Expected initial active tab to be 'Personal', got: '${initialActiveTab}'`);
    }
    console.log(`  [PASS] Initial active tab is: "${initialActiveTab}"`);

    // Click on "Skills" tab
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
      const skillsTab = tabs.find(t => t.textContent.trim() === "Skills");
      if (skillsTab) skillsTab.click();
    });
    await new Promise((r) => setTimeout(r, 1200)); // wait for smooth scroll to finish

    const activeTabAfterClick = await page.evaluate(() => {
      const activeBtn = document.querySelector('button[role="tab"][aria-selected="true"]');
      return activeBtn ? activeBtn.textContent.trim() : null;
    });
    if (activeTabAfterClick !== "Skills") {
      throw new Error(`Expected active tab after click to be 'Skills', got: '${activeTabAfterClick}'`);
    }
    console.log(`  [PASS] Click-to-scroll activated tab: "${activeTabAfterClick}"`);

    // Scroll up to top section
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    await new Promise((r) => setTimeout(r, 500));

    const activeTabAfterScrollTop = await page.evaluate(() => {
      const activeBtn = document.querySelector('button[role="tab"][aria-selected="true"]');
      return activeBtn ? activeBtn.textContent.trim() : null;
    });
    if (activeTabAfterScrollTop !== "Personal") {
      throw new Error(`Expected active tab after scrolling to top to be 'Personal', got: '${activeTabAfterScrollTop}'`);
    }
    console.log(`  [PASS] Scroll-spy automatically tracked visible section back to: "${activeTabAfterScrollTop}"`);

    console.log("\n==================================================================================");
    console.log("  ALL BROWSER INTERACTION & SCROLL-SPY CHECKS PASSED LOCALLY [PASS-LOCAL]         ");
    console.log("==================================================================================");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

runBrowserChecks().catch((err) => {
  console.error("\nBROWSER CHECK FAILED:", err);
  process.exit(1);
});
