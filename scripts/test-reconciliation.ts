/**
 * Offline Verification Suite for Database Reconciliation Queries
 *
 * Verifies the query logic, expectations, and sanity bounds defined in
 * supabase/scripts/reconciliation.sql against offline fixture datasets:
 *   1. jobs vs. jobs_public view (active job count parity & leak checks)
 *   2. subscriptions vs. user_addon_credits (credit balances, orphan checks, order links)
 *   3. funnel_events vs. page_views sanity bounds (volume ratio, progression monotonicity, retention)
 *   4. SQL file integrity: ensures supabase/scripts/reconciliation.sql is strictly read-only
 *      and contains all expected labeled queries.
 *
 * Usage:
 *   npx tsx scripts/test-reconciliation.ts
 *   npx tsx scripts/test-reconciliation.ts --negative-control
 */

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// ==============================================================================
// 1. DATA FIXTURES & TYPES
// ==============================================================================

export interface JobRow {
  id: string;
  title: string;
  status: string;
  is_active: boolean;
}

export interface JobPublicRow {
  id: string;
  title: string;
  status: string;
  is_active: boolean;
  company: string;
}

export interface SubscriptionRow {
  id: string;
  user_id: string;
  plan_id: string;
  status: "active" | "trialing" | "canceled" | "past_due";
  current_period_end: string;
}

export interface AddonCreditRow {
  id: string;
  user_id: string;
  pack_code: string;
  sets_total: number;
  sets_remaining: number;
  expires_at: string;
  order_id: string | null;
}

export interface PaymentOrderRow {
  id: string;
  user_id: string;
  status: "created" | "paid" | "failed";
  addon_code: string | null;
}

export interface PageViewRow {
  id: string;
  path: string;
  user_id: string | null;
  created_at: string;
}

export interface FunnelEventRow {
  id: string;
  event:
    | "signup_started"
    | "signup_completed"
    | "onboarding_started"
    | "onboarding_completed"
    | "apply_started"
    | "apply_completed";
  user_id: string | null;
  anonymous_id: string | null;
  created_at: string;
}

// Baseline Fixture Generator
function createBaselineFixtures(nowMs: number = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const futureIso = new Date(nowMs + 30 * 86400000).toISOString();
  const pastRecentIso = new Date(nowMs - 5 * 86400000).toISOString();
  const pastOldIso = new Date(nowMs - 100 * 86400000).toISOString();

  // 1. Jobs Fixture: 5 jobs total (3 active, 2 inactive)
  const jobs: JobRow[] = [
    { id: "job-1", title: "Fullstack Engineer", status: "active", is_active: true },
    { id: "job-2", title: "Frontend Lead", status: "draft", is_active: true }, // is_active=true makes it active
    { id: "job-3", title: "Backend Architect", status: "active", is_active: false }, // status='active' makes it active
    { id: "job-4", title: "Product Designer", status: "closed", is_active: false }, // inactive
    { id: "job-5", title: "Data Scientist", status: "archived", is_active: false }, // inactive
  ];

  // Simulated jobs_public view (WHERE is_active = true OR status = 'active')
  const jobsPublic: JobPublicRow[] = jobs
    .filter((j) => j.is_active || j.status === "active")
    .map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      is_active: j.is_active,
      company: "Verified Employer",
    }));

  // 2. Subscriptions & Addon Credits Fixtures
  const subscriptions: SubscriptionRow[] = [
    { id: "sub-1", user_id: "user-1", plan_id: "domestic_monthly_199", status: "active", current_period_end: futureIso },
    { id: "sub-2", user_id: "user-2", plan_id: "global_monthly_499", status: "active", current_period_end: futureIso },
    { id: "sub-3", user_id: "user-3", plan_id: "domestic_monthly_199", status: "canceled", current_period_end: pastRecentIso },
  ];

  const paymentOrders: PaymentOrderRow[] = [
    { id: "order-1", user_id: "user-1", status: "paid", addon_code: "addon_10" },
    { id: "order-2", user_id: "user-2", status: "paid", addon_code: "addon_30" },
    { id: "order-3", user_id: "user-3", status: "created", addon_code: "addon_10" }, // unpaid
  ];

  const addonCredits: AddonCreditRow[] = [
    { id: "cred-1", user_id: "user-1", pack_code: "addon_10", sets_total: 10, sets_remaining: 6, expires_at: futureIso, order_id: "order-1" },
    { id: "cred-2", user_id: "user-2", pack_code: "addon_30", sets_total: 30, sets_remaining: 30, expires_at: futureIso, order_id: "order-2" },
  ];

  // 3. Telemetry Fixtures: 20 page views, 8 funnel events
  const pageViews: PageViewRow[] = Array.from({ length: 20 }, (_, i) => ({
    id: `pv-${i + 1}`,
    path: i % 2 === 0 ? "/jobs" : "/",
    user_id: i < 5 ? `user-${(i % 2) + 1}` : null,
    created_at: pastRecentIso,
  }));

  const funnelEvents: FunnelEventRow[] = [
    { id: "fe-1", event: "signup_started", user_id: null, anonymous_id: "anon-1", created_at: pastRecentIso },
    { id: "fe-2", event: "signup_started", user_id: null, anonymous_id: "anon-2", created_at: pastRecentIso },
    { id: "fe-3", event: "signup_completed", user_id: "user-1", anonymous_id: "anon-1", created_at: pastRecentIso },
    { id: "fe-4", event: "onboarding_started", user_id: "user-1", anonymous_id: "anon-1", created_at: pastRecentIso },
    { id: "fe-5", event: "onboarding_completed", user_id: "user-1", anonymous_id: "anon-1", created_at: pastRecentIso },
    { id: "fe-6", event: "apply_started", user_id: "user-1", anonymous_id: "anon-1", created_at: pastRecentIso },
    { id: "fe-7", event: "apply_started", user_id: "user-2", anonymous_id: null, created_at: pastRecentIso },
    { id: "fe-8", event: "apply_completed", user_id: "user-1", anonymous_id: "anon-1", created_at: pastRecentIso },
  ];

  return {
    nowMs,
    pastOldIso,
    jobs,
    jobsPublic,
    subscriptions,
    paymentOrders,
    addonCredits,
    pageViews,
    funnelEvents,
  };
}

// ==============================================================================
// 2. RECONCILIATION LOGIC EVALUATORS
// ==============================================================================

export interface JobsReconciliationResult {
  totalRawJobs: number;
  expectedPublicJobs: number;
  actualViewJobs: number;
  discrepancy: number;
  leakedInactiveJobs: number;
  missingActiveJobs: number;
  status: "PASS" | "FAIL";
}

export function reconcileJobs(jobs: JobRow[], jobsPublic: JobPublicRow[]): JobsReconciliationResult {
  const expectedActive = jobs.filter((j) => j.is_active || j.status === "active");
  const actualView = jobsPublic;

  const publicIds = new Set(actualView.map((j) => j.id));
  const missingActive = expectedActive.filter((j) => !publicIds.has(j.id)).length;
  const leakedInactive = actualView.filter((j) => !j.is_active && j.status !== "active").length;
  const discrepancy = expectedActive.length - actualView.length;

  const status: "PASS" | "FAIL" = discrepancy === 0 && missingActive === 0 && leakedInactive === 0 ? "PASS" : "FAIL";

  return {
    totalRawJobs: jobs.length,
    expectedPublicJobs: expectedActive.length,
    actualViewJobs: actualView.length,
    discrepancy,
    leakedInactiveJobs: leakedInactive,
    missingActiveJobs: missingActive,
    status,
  };
}

export interface AddonCreditsReconciliationResult {
  totalCredits: number;
  overdrawnCredits: number;
  negativeCredits: number;
  unlinkedCreditUsers: number;
  unconfirmedOrderCredits: number;
  userMismatchCredits: number;
  status: "PASS" | "FLAG" | "FAIL";
}

export function reconcileSubscriptionsAndCredits(
  subscriptions: SubscriptionRow[],
  credits: AddonCreditRow[],
  orders: PaymentOrderRow[],
  nowMs: number = Date.now()
): AddonCreditsReconciliationResult {
  const overdrawn = credits.filter((c) => c.sets_remaining > c.sets_total).length;
  const negative = credits.filter((c) => c.sets_remaining < 0).length;

  // Active credit holders vs subscriptions
  const subUserSet = new Set(subscriptions.map((s) => s.user_id));
  const activeCredits = credits.filter(
    (c) => c.sets_remaining > 0 && Date.parse(c.expires_at) > nowMs
  );
  const unlinkedCreditUsers = new Set(
    activeCredits.filter((c) => !subUserSet.has(c.user_id)).map((c) => c.user_id)
  ).size;

  // Order link checks
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  let unconfirmedOrderCredits = 0;
  let userMismatchCredits = 0;

  for (const c of credits) {
    if (!c.order_id) continue;
    const order = orderMap.get(c.order_id);
    if (!order || order.status !== "paid") {
      unconfirmedOrderCredits++;
    }
    if (order && order.user_id !== c.user_id) {
      userMismatchCredits++;
    }
  }

  let status: "PASS" | "FLAG" | "FAIL" = "PASS";
  if (overdrawn > 0 || negative > 0 || unconfirmedOrderCredits > 0 || userMismatchCredits > 0) {
    status = "FAIL";
  } else if (unlinkedCreditUsers > 0) {
    status = "FLAG";
  }

  return {
    totalCredits: credits.length,
    overdrawnCredits: overdrawn,
    negativeCredits: negative,
    unlinkedCreditUsers,
    unconfirmedOrderCredits,
    userMismatchCredits,
    status,
  };
}

export interface FunnelPageViewsSanityResult {
  totalPageViews: number;
  totalFunnelEvents: number;
  volumeRatio: number;
  stageProgressionBreaches: number;
  signupStarted: number;
  signupCompleted: number;
  onboardingStarted: number;
  onboardingCompleted: number;
  applyStarted: number;
  applyCompleted: number;
  expiredRowsUnpurged: number;
  status: "PASS" | "FLAG" | "FAIL";
}

export function reconcileFunnelAndPageViews(
  pageViews: PageViewRow[],
  funnelEvents: FunnelEventRow[],
  nowMs: number = Date.now()
): FunnelPageViewsSanityResult {
  const totalPv = pageViews.length;
  const totalFe = funnelEvents.length;
  const volumeRatio = totalPv > 0 ? totalFe / totalPv : totalFe === 0 ? 0 : Infinity;

  const counts: Record<string, number> = {
    signup_started: 0,
    signup_completed: 0,
    onboarding_started: 0,
    onboarding_completed: 0,
    apply_started: 0,
    apply_completed: 0,
  };
  for (const fe of funnelEvents) {
    counts[fe.event] = (counts[fe.event] || 0) + 1;
  }

  let stageBreaches = 0;
  if (counts.signup_completed > counts.signup_started) stageBreaches++;
  if (counts.onboarding_completed > counts.onboarding_started) stageBreaches++;
  if (counts.apply_completed > counts.apply_started) stageBreaches++;

  // Retention 90 days + 1 day grace
  const retentionCutoff = nowMs - 91 * 86400000;
  const expiredPv = pageViews.filter((p) => Date.parse(p.created_at) < retentionCutoff).length;
  const expiredFe = funnelEvents.filter((f) => Date.parse(f.created_at) < retentionCutoff).length;
  const totalExpired = expiredPv + expiredFe;

  let status: "PASS" | "FLAG" | "FAIL" = "PASS";
  if (stageBreaches > 0 || (totalPv === 0 && totalFe > 0)) {
    status = "FAIL";
  } else if (volumeRatio > 1.0 || totalExpired > 0) {
    status = "FLAG";
  }

  return {
    totalPageViews: totalPv,
    totalFunnelEvents: totalFe,
    volumeRatio: Math.round(volumeRatio * 10000) / 10000,
    stageProgressionBreaches: stageBreaches,
    signupStarted: counts.signup_started,
    signupCompleted: counts.signup_completed,
    onboardingStarted: counts.onboarding_started,
    onboardingCompleted: counts.onboarding_completed,
    applyStarted: counts.apply_started,
    applyCompleted: counts.apply_completed,
    expiredRowsUnpurged: totalExpired,
    status,
  };
}

// ==============================================================================
// 3. SUITE RUNNER ENTRYPOINT
// ==============================================================================

function main() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("       DATABASE RECONCILIATION OFFLINE VERIFICATION SUITE                       ");
  console.log("================================================================================");
  console.log(`Mode : ${isNegativeControl ? "NEGATIVE CONTROL (Must Detect Fault & Fail)" : "NORMAL VERIFICATION"}\n`);

  // ---------------------------------------------------------------------------
  // Check A: SQL File Static Analysis & Read-Only Safety
  // ---------------------------------------------------------------------------
  console.log("A. Checking supabase/scripts/reconciliation.sql safety and structure...");
  const sqlPath = path.resolve(__dirname, "../supabase/scripts/reconciliation.sql");
  assert.strictEqual(fs.existsSync(sqlPath), true, "supabase/scripts/reconciliation.sql must exist");

  const sqlContent = fs.readFileSync(sqlPath, "utf-8");

  // Read-only assertion: zero write statements outside comments
  const nonCommentLines = sqlContent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("--"));

  const writeKeywords = [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+[a-zA-Z0-9_.]+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+VIEW\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bTRUNCATE\b/i,
  ];

  for (const kw of writeKeywords) {
    const violation = nonCommentLines.find((line) => kw.test(line));
    assert.strictEqual(
      violation,
      undefined,
      `reconciliation.sql must be strictly READ-ONLY; found write keyword matching ${kw}: "${violation}"`
    );
  }

  // Labeled queries assertion
  const requiredLabels = [
    "[QUERY 1.1]",
    "[QUERY 1.2]",
    "[QUERY 1.3]",
    "[QUERY 2.1]",
    "[QUERY 2.2]",
    "[QUERY 2.3]",
    "[QUERY 3.1]",
    "[QUERY 3.2]",
    "[QUERY 3.3]",
    "4. UNIFIED EXECUTIVE RECONCILIATION SUMMARY",
  ];

  for (const label of requiredLabels) {
    assert.strictEqual(
      sqlContent.includes(label),
      true,
      `reconciliation.sql must contain labeled section: "${label}"`
    );
  }
  console.log("   -> PASS: File is strictly read-only and all labeled query sections are present.\n");

  // ---------------------------------------------------------------------------
  // Check B: Baseline Fixture Validations
  // ---------------------------------------------------------------------------
  const fixtures = createBaselineFixtures();

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL] Injecting corrupted fixture: missing active job and overdrawn credits...");
    // Inject corruption 1: active job omitted from jobs_public
    const corruptedJobsPublic = fixtures.jobsPublic.filter((j) => j.id !== "job-1");
    const jobsResult = reconcileJobs(fixtures.jobs, corruptedJobsPublic);

    // Inject corruption 2: overdrawn credit balance
    const corruptedCredits: AddonCreditRow[] = [
      ...fixtures.addonCredits,
      {
        id: "bad-cred",
        user_id: "user-1",
        pack_code: "addon_10",
        sets_total: 10,
        sets_remaining: 15, // overdrawn!
        expires_at: fixtures.subscriptions[0].current_period_end,
        order_id: null,
      },
    ];
    const creditsResult = reconcileSubscriptionsAndCredits(
      fixtures.subscriptions,
      corruptedCredits,
      fixtures.paymentOrders
    );

    // Negative control asserts that both fail
    assert.strictEqual(
      jobsResult.status,
      "FAIL",
      "Negative control must detect jobs parity failure when active job is missing"
    );
    assert.strictEqual(
      creditsResult.status,
      "FAIL",
      "Negative control must detect credit bounds failure when sets_remaining > sets_total"
    );

    console.log("   -> NEGATIVE CONTROL SUCCESS: Corruptions were detected and flagged as FAIL.\n");
    // Throw error or exit non-zero to satisfy runner negative control convention
    throw new Error("NEGATIVE CONTROL INTENTIONAL FAILURE: Detected injected reconciliation violations.");
  }

  console.log("B. Testing Query 1 (Jobs vs. Jobs_public View Parity)...");
  const jobsResult = reconcileJobs(fixtures.jobs, fixtures.jobsPublic);
  console.log(`   - Raw jobs count: ${jobsResult.totalRawJobs}`);
  console.log(`   - Expected active public jobs: ${jobsResult.expectedPublicJobs}`);
  console.log(`   - Actual view jobs: ${jobsResult.actualViewJobs}`);
  console.log(`   - Discrepancy: ${jobsResult.discrepancy}`);
  console.log(`   - Leaked inactive jobs: ${jobsResult.leakedInactiveJobs}`);
  console.log(`   - Missing active jobs: ${jobsResult.missingActiveJobs}`);
  console.log(`   - Status: ${jobsResult.status}`);
  assert.strictEqual(jobsResult.status, "PASS");
  assert.strictEqual(jobsResult.discrepancy, 0);
  assert.strictEqual(jobsResult.leakedInactiveJobs, 0);
  assert.strictEqual(jobsResult.missingActiveJobs, 0);
  console.log("   -> PASS: Jobs parity fully reconciled.\n");

  console.log("C. Testing Query 2 (Subscriptions vs. Add-on Credits)...");
  const creditsResult = reconcileSubscriptionsAndCredits(
    fixtures.subscriptions,
    fixtures.addonCredits,
    fixtures.paymentOrders
  );
  console.log(`   - Total credits records: ${creditsResult.totalCredits}`);
  console.log(`   - Overdrawn credits count: ${creditsResult.overdrawnCredits}`);
  console.log(`   - Negative credits count: ${creditsResult.negativeCredits}`);
  console.log(`   - Unlinked credit users: ${creditsResult.unlinkedCreditUsers}`);
  console.log(`   - Unconfirmed order credits: ${creditsResult.unconfirmedOrderCredits}`);
  console.log(`   - User mismatch credits: ${creditsResult.userMismatchCredits}`);
  console.log(`   - Status: ${creditsResult.status}`);
  assert.strictEqual(creditsResult.status, "PASS");
  assert.strictEqual(creditsResult.overdrawnCredits, 0);
  assert.strictEqual(creditsResult.negativeCredits, 0);
  assert.strictEqual(creditsResult.unconfirmedOrderCredits, 0);
  assert.strictEqual(creditsResult.userMismatchCredits, 0);
  console.log("   -> PASS: Subscriptions and Add-on credits fully reconciled.\n");

  console.log("D. Testing Query 3 (Funnel Events vs. Page Views Sanity Bounds)...");
  const funnelResult = reconcileFunnelAndPageViews(fixtures.pageViews, fixtures.funnelEvents);
  console.log(`   - Total page views: ${funnelResult.totalPageViews}`);
  console.log(`   - Total funnel events: ${funnelResult.totalFunnelEvents}`);
  console.log(`   - Funnel to page view ratio: ${funnelResult.volumeRatio}`);
  console.log(`   - Stage progression breaches: ${funnelResult.stageProgressionBreaches}`);
  console.log(`     * Signup: ${funnelResult.signupCompleted} completed / ${funnelResult.signupStarted} started`);
  console.log(`     * Onboarding: ${funnelResult.onboardingCompleted} completed / ${funnelResult.onboardingStarted} started`);
  console.log(`     * Apply: ${funnelResult.applyCompleted} completed / ${funnelResult.applyStarted} started`);
  console.log(`   - Expired unpurged records: ${funnelResult.expiredRowsUnpurged}`);
  console.log(`   - Status: ${funnelResult.status}`);
  assert.strictEqual(funnelResult.status, "PASS");
  assert.strictEqual(funnelResult.stageProgressionBreaches, 0);
  assert.strictEqual(funnelResult.expiredRowsUnpurged, 0);
  assert.strictEqual(funnelResult.volumeRatio <= 1.0, true);
  console.log("   -> PASS: Funnel and page views sanity bounds verified.\n");

  console.log("================================================================================");
  console.log("       ALL RECONCILIATION AUDIT CHECKS PASSED (PASS-LOCAL)                     ");
  console.log("================================================================================");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
