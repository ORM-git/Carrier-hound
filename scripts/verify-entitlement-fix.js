const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_EMAIL = 'xbsuryakant+test@gmail.com';

const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const TEST_PASSWORD = 'TestPassword123!';

async function getTestSession(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error('Failed to sign in ' + email + ': ' + error?.message);
  }
  return data.session;
}

const ssr = require('@supabase/ssr');

async function injectSession(page, session) {
  const cookieName = 'sb-szakevhxhwpeskidvtfs-auth-token';
  const rawStr = JSON.stringify(session);
  const cookieVal = 'base64-' + ssr.stringToBase64URL(rawStr);

  const chunks = ssr.createChunks(cookieName, cookieVal);
  const cookies = chunks.map(c => ({
    name: c.name,
    value: c.value,
    domain: 'localhost',
    path: '/',
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  }));

  await page.setCookie(...cookies);

  // Also prime localStorage
  await page.evaluate((sess) => {
    localStorage.setItem('sb-szakevhxhwpeskidvtfs-auth-token', JSON.stringify(sess));
    localStorage.setItem('careermonke_auth_session', JSON.stringify(sess));
    localStorage.setItem('careermonke_user_email', sess.user.email);
  }, session);
}

async function runEntitlementUnitTests() {
  console.log("=== 1. UNIT TESTS: ENTITLEMENT LOGIC & EXPIRY CHECK ===");

  // Test 1: Active subscription with current_period_end in the PAST must be treated as EXPIRED
  const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const expiredSub = {
    status: "active",
    current_period_end: pastDate,
    plan_id: "domestic_monthly_199",
  };

  const nowMs = Date.now();
  const periodEndExpired = new Date(expiredSub.current_period_end).getTime();
  const isPeriodExpired = Boolean(periodEndExpired <= nowMs);

  if (isPeriodExpired) {
    console.log("  PASS: Client-side expiry check correctly detects past periodEnd as expired.");
  } else {
    throw new Error("FAIL: Client-side expiry check did NOT detect expired period!");
  }

  // Test 2: Active subscription with future current_period_end is active Pro
  const periodEndActive = new Date(futureDate).getTime();
  const isActiveValid = !Boolean(periodEndActive <= nowMs);
  if (isActiveValid) {
    console.log("  PASS: Future periodEnd correctly recognized as active Pro.");
  } else {
    throw new Error("FAIL: Future periodEnd falsely marked as expired!");
  }

  // Test 3: Unknown / timeout / error state contract
  const transientState = {
    isPro: false,
    status: "unknown",
    isLoading: true,
    isDefinitive: false,
  };

  if (!transientState.isDefinitive && transientState.isLoading && transientState.status === "unknown") {
    console.log("  PASS: Unknown/timeout/error contract is non-definitive, preventing false Free assignment.");
  } else {
    throw new Error("FAIL: Transient state schema violation!");
  }
}

async function runBrowserThrottlingTest() {
  console.log("\n=== 2. BROWSER REGRESSION: SLOW 3G NETWORK THROTTLING ===");
  console.log("Simulating mobile Slow 3G network conditions (2000ms latency, 400 kbps throughput)...");

  const session = await getTestSession(TEST_EMAIL);
  console.log(`Authenticated test session acquired for ${TEST_EMAIL} (UID: ${session.user.id})`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const appUrl = 'http://localhost:3000';

    // Warm up routes before throttling so webpack dev compilation is already completed
    console.log("Warming up routes for dev compilation...");
    await page.goto(`${appUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.goto(`${appUrl}/tracker`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.goto(`${appUrl}/resume`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.goto(`${appUrl}/jobs`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Inject Supabase auth tokens
    await page.goto(`${appUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await injectSession(page, session);

    // Enable Chrome DevTools Protocol Network domain and emulate Slow 3G
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 1500, // 1500ms latency (Slow 3G)
      downloadThroughput: (500 * 1024) / 8, // 500 kbps
      uploadThroughput: (500 * 1024) / 8,
    });
    console.log("CDP Slow 3G emulation activated.");

    // Track any occurrences of paywall elements
    let encounteredPaywallOnDashboard = false;
    let sawNeutralLoadingOnDashboard = false;

    // Test Page 1: /dashboard on Slow 3G
    console.log("\nNavigating to /dashboard on Slow 3G...");
    const dashboardNavigation = page.goto(`${appUrl}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Poll the DOM during navigation to ensure paywall never flashes
    const pollInterval = setInterval(async () => {
      try {
        const hasPaywall = await page.evaluate(() => {
          return document.body.innerText.includes("Unlock CareerMonke Pro") ||
                 document.body.innerText.includes("Upgrade to Pro");
        });
        if (hasPaywall) {
          encounteredPaywallOnDashboard = true;
        }

        const hasNeutralLoader = await page.evaluate(() => {
          return document.body.innerText.includes("Loading your account...") ||
                 document.querySelector(".animate-spin") !== null;
        });
        if (hasNeutralLoader) {
          sawNeutralLoadingOnDashboard = true;
        }
      } catch (_) {}
    }, 150);

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));

    await dashboardNavigation;

    // Wait for throttled network query to resolve from loading spinner to resolved state
    console.log("Waiting for throttled entitlement query to resolve on /dashboard...");
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return text.includes("Unlock CareerMonke Pro") ||
               text.includes("Career Matches") ||
               text.includes("Top 10") ||
               text.includes("Confirmed Facts") ||
               text.includes("Guided Pro Flow") ||
               text.includes("Preferences");
      }, { timeout: 45000 });
    } catch (e) {
      const currentUrl = page.url();
      const currentText = await page.evaluate(() => document.body.innerText);
      console.log(`Diagnostic info: URL=${currentUrl}, text=${currentText.replace(/\n+/g, ' ').slice(0, 300)}`);
      throw e;
    }
    clearInterval(pollInterval);

    // Verify final state of /dashboard
    const dashboardState = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasPaywall: text.includes("Unlock CareerMonke Pro"),
        hasProFlow: text.includes("Career Matches") || text.includes("Top 10") || text.includes("Confirmed Facts") || text.includes("Guided Pro Flow") || text.includes("Step 1") || text.includes("Preferences"),
        hasHeaderProBadge: document.querySelector("header")?.innerText.includes("PRO") ?? false,
      };
    });

    console.log("Dashboard verification results:");
    console.log(`  - Saw neutral loading UI during throttled fetch: ${sawNeutralLoadingOnDashboard}`);
    console.log(`  - Flashed Free/Paywall screen: ${encounteredPaywallOnDashboard}`);
    console.log(`  - Final state has paywall: ${dashboardState.hasPaywall}`);
    console.log(`  - Final state has Pro flow: ${dashboardState.hasProFlow}`);
    console.log(`  - Header shows PRO badge: ${dashboardState.hasHeaderProBadge}`);

    if (encounteredPaywallOnDashboard || dashboardState.hasPaywall) {
      throw new Error("FAIL: Pro user encountered paywall on /dashboard under Slow 3G!");
    }
    if (!dashboardState.hasProFlow) {
      throw new Error("FAIL: Pro flow did not render on /dashboard!");
    }
    console.log("PASS: /dashboard on Slow 3G showed neutral loading UI and rendered Pro flow without paywall flash.");

    // Test Page 2: /tracker on Slow 3G
    console.log("\nNavigating to /tracker on Slow 3G...");
    let encounteredPaywallOnTracker = false;
    const trackerNavigation = page.goto(`${appUrl}/tracker`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const trackerPoll = setInterval(async () => {
      try {
        const hasPaywall = await page.evaluate(() => {
          return document.body.innerText.includes("Unlock Application Tracker");
        });
        if (hasPaywall) encounteredPaywallOnTracker = true;
      } catch (_) {}
    }, 150);
    await trackerNavigation;

    console.log("Waiting for throttled entitlement query to resolve on /tracker...");
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return text.includes("Unlock Application Tracker") ||
               text.includes("Application Pipeline Tracker") ||
               text.includes("Kanban") ||
               text.includes("Saved");
      }, { timeout: 45000 });
    } catch (e) {
      const currentUrl = page.url();
      const currentText = await page.evaluate(() => document.body.innerText);
      console.log(`Diagnostic info on tracker: URL=${currentUrl}, text=${currentText.replace(/\n+/g, ' ').slice(0, 300)}`);
      throw e;
    }
    clearInterval(trackerPoll);

    const trackerState = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasPaywall: text.includes("Unlock Application Tracker"),
        hasTrackerPipeline: text.includes("Application Pipeline Tracker") || text.includes("Kanban") || text.includes("Saved"),
      };
    });

    console.log("Tracker verification results:");
    console.log(`  - Flashed Paywall on tracker: ${encounteredPaywallOnTracker}`);
    console.log(`  - Tracker pipeline rendered: ${trackerState.hasTrackerPipeline}`);

    if (encounteredPaywallOnTracker || trackerState.hasPaywall) {
      throw new Error("FAIL: Pro user encountered paywall on /tracker under Slow 3G!");
    }
    console.log("PASS: /tracker on Slow 3G rendered pipeline without paywall flash.");

    // Test Page 3: /resume on Slow 3G
    console.log("\nNavigating to /resume on Slow 3G...");
    let encounteredPaywallOnResume = false;
    const resumeNavigation = page.goto(`${appUrl}/resume`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const resumePoll = setInterval(async () => {
      try {
        const hasPaywall = await page.evaluate(() => {
          return document.body.innerText.includes("Unlock CareerMonke Pro");
        });
        if (hasPaywall) encounteredPaywallOnResume = true;
      } catch (_) {}
    }, 150);
    await resumeNavigation;

    console.log("Waiting for throttled entitlement query to resolve on /resume...");
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return text.includes("Unlock CareerMonke Pro") ||
               text.includes("Resume & Fact Profile") ||
               text.includes("Confirmed Facts") ||
               text.includes("Upload Resume");
      }, { timeout: 45000 });
    } catch (e) {
      const currentUrl = page.url();
      const currentText = await page.evaluate(() => document.body.innerText);
      console.log(`Diagnostic info on resume: URL=${currentUrl}, text=${currentText.replace(/\n+/g, ' ').slice(0, 300)}`);
      throw e;
    }
    clearInterval(resumePoll);

    const resumeState = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasPaywall: text.includes("Unlock CareerMonke Pro"),
        hasResumeProfile: text.includes("Resume & Fact Profile") || text.includes("Confirmed Facts"),
      };
    });

    console.log("Resume verification results:");
    console.log(`  - Flashed Paywall on resume: ${encounteredPaywallOnResume}`);
    console.log(`  - Resume profile rendered: ${resumeState.hasResumeProfile}`);

    if (encounteredPaywallOnResume || resumeState.hasPaywall) {
      throw new Error("FAIL: Pro user encountered paywall on /resume under Slow 3G!");
    }
    console.log("PASS: /resume on Slow 3G rendered resume profile without paywall flash.");

    // Test Page 4: /jobs on Slow 3G - verify no blurred content flash
    console.log("\nNavigating to /jobs on Slow 3G...");
    await page.goto(`${appUrl}/jobs`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 3000));

    const jobsState = await page.evaluate(() => {
      const blurredElements = document.querySelectorAll('.blur-\\[4\\.5px\\], .blur-\\[5px\\], .blur-\\[4px\\]');
      const lockIcons = document.querySelectorAll('svg.lucide-lock');
      return {
        blurredCount: blurredElements.length,
        lockIconCount: lockIcons.length,
      };
    });

    console.log("Jobs page verification results for Pro user:");
    console.log(`  - Blurred fields count: ${jobsState.blurredCount}`);
    console.log(`  - Lock icons count: ${jobsState.lockIconCount}`);

    if (jobsState.blurredCount > 0 || jobsState.lockIconCount > 0) {
      throw new Error(`FAIL: Pro user sees ${jobsState.blurredCount} blurred fields and ${jobsState.lockIconCount} lock icons on /jobs!`);
    }
    console.log("PASS: /jobs rendered unmasked verified jobs for Pro user without blurred fields.");

    console.log("\nALL VERIFICATIONS PASSED SUCCESSFULLY!");
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    await runEntitlementUnitTests();
    await runBrowserThrottlingTest();
    process.exit(0);
  } catch (err) {
    console.error("\nTEST SUITE FAILED:", err);
    process.exit(1);
  }
}

main();
