const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const ssr = require("@supabase/ssr");
require("dotenv").config({ path: ".env.local" });

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARTIFACT_DIR = "C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\caf034a4-a523-4c7f-8755-7fa4fad550ba";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const adminClient = createClient(supabaseUrl, serviceKey);
const anonClient = createClient(supabaseUrl, anonKey);

async function getRealSession(email) {
  const linkRes = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  const otp = linkRes.data?.properties?.email_otp;
  if (!otp) throw new Error(`Could not generate OTP for ${email}`);

  const verifyRes = await anonClient.auth.verifyOtp({
    email,
    token: otp,
    type: "magiclink",
  });

  if (!verifyRes.data?.session) {
    throw new Error(`Failed to verify session for ${email}`);
  }

  return verifyRes.data.session;
}

async function injectSession(page, session) {
  const cookieName = "sb-szakevhxhwpeskidvtfs-auth-token";
  const rawStr = JSON.stringify(session);
  const cookieVal = "base64-" + ssr.stringToBase64URL(rawStr);

  const chunks = ssr.createChunks(cookieName, cookieVal);
  const cookies = chunks.map((c) => ({
    name: c.name,
    value: c.value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  }));

  await page.setCookie(...cookies);

  // Prime localStorage
  await page.evaluate((sess) => {
    localStorage.setItem("careermonke_user_email", sess.user.email);
    localStorage.setItem("careermonke_pro_active", "true");
    localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
  }, session);
}

async function clearSession(page) {
  const cookies = await page.cookies();
  if (cookies.length > 0) {
    await page.deleteCookie(...cookies);
  }
  await page.evaluate(() => {
    localStorage.clear();
  });
}

async function runBrowserTests() {
  console.log("================================================================================");
  console.log("ADMIN BROWSER E2E TEST SUITE (PUPPETEER)");
  console.log("================================================================================\n");

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--window-size=1440,900"],
    defaultViewport: { width: 1440, height: 900 },
  });

  try {
    const page = await browser.newPage();

    // -------------------------------------------------------------------------
    // TEST 1: GUEST REDIRECTION (Unauthenticated user hits /admin)
    // -------------------------------------------------------------------------
    console.log("--- 1. Testing Guest Access to /admin ---");
    await page.goto("http://localhost:3000/");
    await clearSession(page);

    await page.goto("http://localhost:3000/admin");
    await new Promise((r) => setTimeout(r, 2000));
    const guestUrl = page.url();
    console.log(`Navigated to /admin -> Result URL: ${guestUrl}`);
    if (guestUrl === "http://localhost:3000/" || guestUrl.endsWith(":3000/")) {
      console.log("[PASS] Guest visitor hitting /admin was successfully redirected to homepage!");
    } else {
      console.error(`[FAIL] Guest was NOT redirected to homepage, stayed on: ${guestUrl}`);
      process.exit(1);
    }

    // -------------------------------------------------------------------------
    // TEST 2: NON-ADMIN REDIRECTION (Real authenticated non-admin user hits /admin)
    // -------------------------------------------------------------------------
    console.log("\n--- 2. Testing Non-Admin User Access to /admin ---");
    const nonAdminSession = await getRealSession("xbsuryakant+free@gmail.com");

    await page.goto("http://localhost:3000/");
    await clearSession(page);
    await injectSession(page, nonAdminSession);

    await page.goto("http://localhost:3000/admin");
    await new Promise((r) => setTimeout(r, 2500));
    const nonAdminUrl = page.url();
    console.log(`Non-admin navigated to /admin -> Result URL: ${nonAdminUrl}`);
    if (nonAdminUrl === "http://localhost:3000/" || nonAdminUrl.endsWith(":3000/")) {
      console.log("[PASS] Non-admin logged-in user hitting /admin was successfully redirected to homepage!");
    } else {
      console.error(`[FAIL] Non-admin was NOT redirected to homepage, stayed on: ${nonAdminUrl}`);
      process.exit(1);
    }

    // -------------------------------------------------------------------------
    // TEST 3: ADMIN ACCESS TO /admin (Real authenticated admin: xbsuryakant@gmail.com)
    // -------------------------------------------------------------------------
    console.log("\n--- 3. Testing Admin Access to /admin ---");
    const adminSession = await getRealSession("xbsuryakant@gmail.com");

    await page.goto("http://localhost:3000/");
    await clearSession(page);
    await injectSession(page, adminSession);

    await page.goto("http://localhost:3000/admin");
    await new Promise((r) => setTimeout(r, 3000));
    const adminUrl = page.url();
    console.log(`Admin navigated to /admin -> Result URL: ${adminUrl}`);

    if (adminUrl.includes("/admin")) {
      console.log("[PASS] Admin successfully granted access to /admin dashboard!");
    } else {
      console.error(`[FAIL] Admin was incorrectly redirected away from /admin to: ${adminUrl}`);
      process.exit(1);
    }

    // Wait for analytics data to render
    await page.waitForSelector("h1", { timeout: 10000 });
    const headingText = await page.$eval("h1", (el) => el.innerText);
    console.log(`Page Heading: "${headingText}"`);

    // Verify KPI cards and Top Pages table exist
    const hasTopPages = await page.evaluate(() => {
      const body = document.body.innerText.toUpperCase();
      return (
        body.includes("TOP PAGES RANKED") &&
        body.includes("TOTAL PAGE VIEWS") &&
        body.includes("UNIQUE VISITORS")
      );
    });
    console.log(`Admin Dashboard elements present: ${hasTopPages}`);
    if (!hasTopPages) {
      console.error("[FAIL] Dashboard missing key metric sections");
      process.exit(1);
    }

    // Take screenshot of Admin Dashboard
    const dashboardScreenshot = path.join(ARTIFACT_DIR, "admin_dashboard_overview.png");
    await page.screenshot({ path: dashboardScreenshot, fullPage: true });
    console.log(`Saved screenshot: ${dashboardScreenshot}`);

    // -------------------------------------------------------------------------
    // TEST 4: ADMIN USERS MANAGEMENT (/admin/users)
    // -------------------------------------------------------------------------
    console.log("\n--- 4. Testing Admin Users Management (/admin/users) ---");
    await page.goto("http://localhost:3000/admin/users");
    await new Promise((r) => setTimeout(r, 3000));
    await page.waitForSelector("table", { timeout: 10000 });

    const hasUsersTable = await page.evaluate(() => {
      return (
        document.body.innerText.includes("User Management") &&
        document.body.innerText.includes("xbsuryakant@gmail.com") &&
        document.body.innerText.includes("Pro") &&
        document.body.innerText.includes("Active")
      );
    });
    console.log(`Users Management table loaded correctly: ${hasUsersTable}`);
    if (!hasUsersTable) {
      console.error("[FAIL] Users management table failed to load user accounts");
      process.exit(1);
    }

    // Click on a "views" button to test user activity timeline modal
    console.log("Testing user activity modal click...");
    const activityBtn = await page.$("button[title='Click to view visited pages']");
    if (activityBtn) {
      await activityBtn.click();
      await new Promise((r) => setTimeout(r, 1000));
      const modalOpen = await page.evaluate(() => {
        return document.body.innerText.includes("User Activity Timeline");
      });
      console.log(`User Activity modal displayed: ${modalOpen}`);
      if (!modalOpen) {
        console.error("[FAIL] User activity modal did not open on click");
        process.exit(1);
      }
    }

    // Take screenshot of Users Management with Activity Modal
    const usersScreenshot = path.join(ARTIFACT_DIR, "admin_users_management.png");
    await page.screenshot({ path: usersScreenshot, fullPage: true });
    console.log(`Saved screenshot: ${usersScreenshot}`);

    // -------------------------------------------------------------------------
    // TEST 5: NAVBAR DOES NOT EXPOSE ADMIN LINK
    // -------------------------------------------------------------------------
    console.log("\n--- 5. Verifying Public Navbar Does NOT Expose Admin Link ---");
    await page.goto("http://localhost:3000/");
    await new Promise((r) => setTimeout(r, 1500));
    const navbarAdminLink = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll("header a, nav a"));
      return links.some(
        (a) => a.getAttribute("href") === "/admin" || a.innerText.toLowerCase().includes("admin")
      );
    });
    console.log(`Public Navbar has admin link: ${navbarAdminLink}`);
    if (navbarAdminLink) {
      console.error("[FAIL] Public navbar illegally contains a link to /admin!");
      process.exit(1);
    } else {
      console.log("[PASS] Public navbar contains 0 admin links (hidden URL-only access preserved).");
    }

    console.log("\n================================================================================");
    console.log("ALL BROWSER E2E TESTS PASSED WITH 100% SUCCESS!");
    console.log("================================================================================");
  } finally {
    await browser.close();
  }
}

runBrowserTests().catch((err) => {
  console.error("Browser test failed:", err);
  process.exit(1);
});
