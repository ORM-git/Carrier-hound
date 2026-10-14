import puppeteer from "puppeteer-core";
import { createClient } from "@supabase/supabase-js";
import * as ssr from "@supabase/ssr";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function run() {
  if (!anonKey || !serviceKey) {
    console.log("[SKIPPED] test_auth_flow.mjs: Missing NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY for 6-digit OTP verification.");
    process.exit(0);
  }

  const adminClient = createClient(supabaseUrl, serviceKey);
  const anonClient = createClient(supabaseUrl, anonKey);
  const testEmail = process.env.TEST_EMAIL;
  if (!testEmail) {
    console.error("TEST_EMAIL environment variable is not set. Please set TEST_EMAIL.");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log("1. Navigating to /login?next=/jobs...");
    await page.goto("http://localhost:3000/login?next=/jobs", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log("2. Waiting for email input...");
    await page.waitForSelector("input#email", { timeout: 15000 });

    console.log("3. Generating 6-digit OTP via Supabase Auth and verifying...");
    const linkRes = await adminClient.auth.admin.generateLink({
      type: "magiclink",
      email: testEmail,
    });
    const otp = linkRes.data?.properties?.email_otp;
    if (!otp || !/^\d{6,8}$/.test(otp)) {
      throw new Error(`Expected numeric OTP for ${testEmail}, got: ${otp ? "invalid format" : "empty"}`);
    }

    const verifyRes = await anonClient.auth.verifyOtp({
      email: testEmail,
      token: otp,
      type: "magiclink",
    });
    const session = verifyRes.data?.session;
    if (!session) {
      throw new Error(`6-digit OTP verification failed: ${verifyRes.error?.message}`);
    }
    console.log("   Verified 6-digit OTP session for:", session.user.email);

    // Inject verified OTP session cookies + localStorage
    const cookieName = "sb-szakevhxhwpeskidvtfs-auth-token";
    const cookieVal = "base64-" + ssr.stringToBase64URL(JSON.stringify(session));
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
    await page.evaluate((sess) => {
      localStorage.setItem("careermonke_user_email", sess.user.email);
      localStorage.setItem("sb-szakevhxhwpeskidvtfs-auth-token", JSON.stringify(sess));
    }, session);

    console.log("4. Reloading /login?next=/jobs to verify authenticated redirect...");
    await page.goto("http://localhost:3000/login?next=/jobs", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForFunction(() => window.location.pathname.includes("/jobs"), { timeout: 15000 });

    const currentUrl = page.url();
    const savedEmail = await page.evaluate(() => localStorage.getItem("careermonke_user_email"));
    console.log("5. Redirected URL:", currentUrl, "| Saved email:", savedEmail);

    if (currentUrl.includes("/jobs") && savedEmail === testEmail) {
      console.log("SUCCESS: 6-digit OTP auth verification and redirect works perfectly!");
    } else {
      console.error("FAIL: Did not redirect or save email properly.");
      process.exit(1);
    }
  } catch (err) {
    console.error("Error during auth flow test:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
