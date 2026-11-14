/**
 * scripts/test-onboarding-persistence.ts
 *
 * Verification suite for:
 * 1. Database & Server-Side Onboarding Persistence:
 *    - profiles.onboarding_completed_at marks account as completed.
 *    - Existing users with saved profile or preferences are automatically treated as completed.
 *    - Brand new users (first login) are marked as NOT completed.
 *    - Self-healing: existing users lacking onboarding_completed_at are backfilled on first check.
 * 2. Auth & Middleware Navigation Guard:
 *    - First login: redirected from /login and /auth/callback to /onboarding.
 *    - First login: allowed to view /onboarding.
 *    - Repeat login: redirected from /login and /auth/callback to /dashboard.
 *    - Repeat login: visiting /onboarding redirects to /dashboard (seen exactly once).
 *    - Guest: visiting /onboarding redirects to /login?returnTo=/onboarding.
 * 3. Settings > Billing & Plans Real Catalog & Subscription:
 *    - Uses real catalog from src/config/plans.ts (Monthly: ₹1,499 / month).
 *    - No fake renewal date when user has no real subscription record.
 *    - Hardcoded obsolete "Rs 199 / month" and "12/14/2026" removed.
 * 4. Negative Control Mode:
 *    - Exits non-zero (1) when run with --negative-control.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { NextRequest } from "next/server";

// Mock @cloudflare/next-on-pages for edge middleware imports in Node.js
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any
) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

process.env.NODE_ENV = "test";
process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS_UNLOCK = "true";

import {
  checkAccountOnboardingCompleted,
  markAccountOnboardingCompleted,
} from "../src/lib/auth/onboarding";
import { middleware } from "../src/middleware";
import { PLANS } from "../src/config/plans";
import { getUserSubscription } from "../src/lib/billing/subscription";

const isNegativeControl = process.argv.includes("--negative-control");

interface MockDbState {
  profiles: Map<string, any>;
  candidate_profiles: Map<string, any>;
  user_preferences: Map<string, any>;
}

function createMockSupabase(state: MockDbState) {
  return {
    from: (table: string) => {
      return {
        select: (columns: string) => {
          return {
            eq: (col: string, val: string) => {
              return {
                maybeSingle: async () => {
                  const map = (state as any)[table] as Map<string, any> | undefined;
                  const row = map?.get(val) || null;
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        upsert: async (payload: any, options?: { onConflict?: string }) => {
          const key = payload.user_id || payload.id;
          const map = (state as any)[table] as Map<string, any> | undefined;
          if (map && key) {
            const existing = map.get(key) || {};
            map.set(key, { ...existing, ...payload });
          }
          return { data: payload, error: null };
        },
        update: (payload: any) => {
          return {
            eq: (col: string, val: string) => {
              const map = (state as any)[table] as Map<string, any> | undefined;
              if (map && val) {
                const existing = map.get(val) || {};
                map.set(val, { ...existing, ...payload });
              }
              return Promise.resolve({ data: payload, error: null });
            },
          };
        },
      };
    },
    auth: {
      getUser: async (token: string) => {
        if (token.startsWith("user-")) {
          return {
            data: {
              user: {
                id: token,
                email: `${token}@gmail.com`,
                email_confirmed_at: "2026-01-01T00:00:00Z",
                app_metadata: { provider: "google", providers: ["google"] },
                user_metadata: {},
              },
            },
            error: null,
          };
        }
        return { data: { user: null }, error: new Error("invalid token") };
      },
      signOut: async () => {},
    },
  };
}

async function runOnboardingSuite() {
  console.log("================================================================================");
  console.log("       CAREERMONKE ONBOARDING PERSISTENCE & SETTINGS BILLING SUITE              ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Verifying test failure on invalid condition...");
    // Deliberately assert false === true
    assert.strictEqual(false, true, "Negative control deliberately triggered failure.");
    return;
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Database Logic - checkAccountOnboardingCompleted
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying checkAccountOnboardingCompleted behavior across account states...");

  const dbState: MockDbState = {
    profiles: new Map(),
    candidate_profiles: new Map(),
    user_preferences: new Map(),
  };

  const mockClient = createMockSupabase(dbState);

  // 1a. Brand new user (first login, no records anywhere)
  const isNewCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-new");
  assert.strictEqual(
    isNewCompleted,
    false,
    "Brand new user with no db records must NOT be marked as onboarding completed."
  );

  // 1b. User with profiles.onboarding_completed_at set
  dbState.profiles.set("user-completed", {
    user_id: "user-completed",
    onboarding_completed_at: "2026-11-14T10:00:00Z",
  });
  const isDirectCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-completed");
  assert.strictEqual(
    isDirectCompleted,
    true,
    "User with profiles.onboarding_completed_at must be marked completed."
  );

  // 1c. Existing user with saved legacy profile (full_name / target_roles)
  dbState.profiles.set("user-legacy-profile", {
    user_id: "user-legacy-profile",
    full_name: "Jane Doe",
    target_roles: ["Frontend Developer"],
    onboarding_completed_at: null,
  });
  const isLegacyCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-legacy-profile");
  assert.strictEqual(
    isLegacyCompleted,
    true,
    "Existing user with saved profile (full_name) must be treated as completed."
  );
  // Verify self-healing: onboarding_completed_at was persisted
  const healedProfile = dbState.profiles.get("user-legacy-profile");
  assert.ok(
    healedProfile?.onboarding_completed_at,
    "Self-healing must stamp profiles.onboarding_completed_at for existing users."
  );

  // 1d. Existing user with saved candidate_profiles (resume confirmed)
  dbState.candidate_profiles.set("user-candidate", {
    user_id: "user-candidate",
    confirmed_at: "2026-10-01T00:00:00Z",
    skills: ["React", "TypeScript"],
  });
  const isCandidateCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-candidate");
  assert.strictEqual(
    isCandidateCompleted,
    true,
    "Existing user with confirmed candidate profile must be treated as completed."
  );
  const healedCandidateProfile = dbState.profiles.get("user-candidate");
  assert.ok(
    healedCandidateProfile?.onboarding_completed_at,
    "Self-healing must stamp profiles.onboarding_completed_at for candidate profile users."
  );

  // 1e. Existing user with saved user_preferences (roles or onboarding_completed)
  dbState.user_preferences.set("user-prefs", {
    user_id: "user-prefs",
    roles: ["Backend Engineer"],
    onboarding_completed: false,
  });
  const isPrefsCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-prefs");
  assert.strictEqual(
    isPrefsCompleted,
    true,
    "Existing user with saved preference roles must be treated as completed."
  );

  console.log("  ✓ Database logic passed (first login vs repeat login vs existing users vs self-healing).\n");

  // ---------------------------------------------------------------------------
  // TEST 2: markAccountOnboardingCompleted Persistence
  // ---------------------------------------------------------------------------
  console.log("Test 2: Verifying markAccountOnboardingCompleted persistence...");

  const timestamp = "2026-11-14T12:00:00.000Z";
  await markAccountOnboardingCompleted(mockClient as any, "user-mark-test", timestamp);

  const markedProfile = dbState.profiles.get("user-mark-test");
  assert.strictEqual(
    markedProfile?.onboarding_completed_at,
    timestamp,
    "markAccountOnboardingCompleted must write to profiles.onboarding_completed_at."
  );
  const markedPrefs = dbState.user_preferences.get("user-mark-test");
  assert.strictEqual(
    markedPrefs?.onboarding_completed,
    true,
    "markAccountOnboardingCompleted must write onboarding_completed=true to user_preferences."
  );

  console.log("  ✓ markAccountOnboardingCompleted correctly persists to both profiles and user_preferences.\n");

  // ---------------------------------------------------------------------------
  // TEST 3: Middleware Routing - First Login vs Repeat Login
  // ---------------------------------------------------------------------------
  console.log("Test 3: Verifying middleware server-side routing (first login vs repeat login)...");

  // Configure global mock Supabase for middleware
  (globalThis as any).__mockSupabaseClient = mockClient;

  // 3a. Guest accessing /onboarding -> redirected to /login?returnTo=/onboarding
  const guestReq = new NextRequest("http://localhost:3000/onboarding");
  const guestRes = await middleware(guestReq);
  assert.strictEqual(guestRes.status, 307, "Guest accessing /onboarding must be redirected (307).");
  const guestLoc = guestRes.headers.get("location") || "";
  assert.ok(
    guestLoc.includes("/login") && guestLoc.includes("returnTo=%2Fonboarding"),
    `Guest must redirect to /login with returnTo=/onboarding, got: ${guestLoc}`
  );

  // 3b. First login: Authenticated new user accessing /login -> redirected to /onboarding
  const newLoginReq = new NextRequest("http://localhost:3000/login", {
    headers: { cookie: "sb-access-token=user-new;" },
  });
  const newLoginRes = await middleware(newLoginReq);
  assert.strictEqual(newLoginRes.status, 307, "First login on /login must redirect (307).");
  assert.ok(
    (newLoginRes.headers.get("location") || "").endsWith("/onboarding"),
    `First login on /login must redirect to /onboarding, got: ${newLoginRes.headers.get("location")}`
  );

  // 3c. First login: Authenticated new user accessing /auth/callback -> redirected to /onboarding
  const newCallbackReq = new NextRequest("http://localhost:3000/auth/callback", {
    headers: { cookie: "sb-access-token=user-new;" },
  });
  const newCallbackRes = await middleware(newCallbackReq);
  assert.strictEqual(newCallbackRes.status, 307, "First login on /auth/callback must redirect (307).");
  assert.ok(
    (newCallbackRes.headers.get("location") || "").endsWith("/onboarding"),
    `First login on /auth/callback must redirect to /onboarding, got: ${newCallbackRes.headers.get("location")}`
  );

  // 3d. First login: Authenticated new user accessing /onboarding -> allowed through (status 200)
  const newOnboardingReq = new NextRequest("http://localhost:3000/onboarding", {
    headers: { cookie: "sb-access-token=user-new;" },
  });
  const newOnboardingRes = await middleware(newOnboardingReq);
  assert.strictEqual(
    newOnboardingRes.status,
    200,
    `First login accessing /onboarding must pass through (200), got: ${newOnboardingRes.status}`
  );

  // 3e. Repeat login: Authenticated completed user accessing /login -> redirected to /dashboard
  const repeatLoginReq = new NextRequest("http://localhost:3000/login", {
    headers: { cookie: "sb-access-token=user-completed;" },
  });
  const repeatLoginRes = await middleware(repeatLoginReq);
  assert.strictEqual(repeatLoginRes.status, 307, "Repeat login on /login must redirect (307).");
  assert.ok(
    (repeatLoginRes.headers.get("location") || "").endsWith("/dashboard"),
    `Repeat login on /login must redirect to /dashboard, got: ${repeatLoginRes.headers.get("location")}`
  );

  // 3f. Repeat login: Authenticated completed user accessing /auth/callback -> redirected to /dashboard
  const repeatCallbackReq = new NextRequest("http://localhost:3000/auth/callback", {
    headers: { cookie: "sb-access-token=user-completed;" },
  });
  const repeatCallbackRes = await middleware(repeatCallbackReq);
  assert.strictEqual(repeatCallbackRes.status, 307, "Repeat login on /auth/callback must redirect (307).");
  assert.ok(
    (repeatCallbackRes.headers.get("location") || "").endsWith("/dashboard"),
    `Repeat login on /auth/callback must redirect to /dashboard, got: ${repeatCallbackRes.headers.get("location")}`
  );

  // 3g. Repeat login: Authenticated completed user accessing /onboarding -> redirected to /dashboard!
  const repeatOnboardingReq = new NextRequest("http://localhost:3000/onboarding", {
    headers: { cookie: "sb-access-token=user-completed;" },
  });
  const repeatOnboardingRes = await middleware(repeatOnboardingReq);
  assert.strictEqual(repeatOnboardingRes.status, 307, "Completed user accessing /onboarding must redirect (307).");
  assert.ok(
    (repeatOnboardingRes.headers.get("location") || "").endsWith("/dashboard"),
    `Completed user accessing /onboarding must redirect to /dashboard, got: ${repeatOnboardingRes.headers.get("location")}`
  );

  console.log("  ✓ Middleware server-side checks passed (first login -> /onboarding, repeat login -> /dashboard).\n");

  // ---------------------------------------------------------------------------
  // TEST 4: Settings > Billing & Plans Plan Catalog & Real Subscription
  // ---------------------------------------------------------------------------
  console.log("Test 4: Verifying Settings > Billing & Plans catalog pricing & subscription dates...");

  // 4a. Real plan catalog verification
  const monthlyPlan = PLANS.find((p) => p.id === "monthly");
  assert.ok(monthlyPlan, "Catalog must define monthly plan.");
  assert.strictEqual(monthlyPlan.price, 1499, "Default Pro monthly plan price must be ₹1,499.");
  assert.strictEqual(monthlyPlan.currency, "INR", "Default Pro monthly currency must be INR.");
  assert.strictEqual(monthlyPlan.isDefault, true, "Monthly plan must be marked isDefault: true.");

  const weeklyPlan = PLANS.find((p) => p.id === "weekly");
  assert.ok(weeklyPlan, "Catalog must define weekly plan.");
  assert.strictEqual(weeklyPlan.price, 692, "Weekly plan price must be ₹692.");

  const quarterlyPlan = PLANS.find((p) => p.id === "quarterly");
  assert.ok(quarterlyPlan, "Catalog must define quarterly plan.");
  assert.strictEqual(quarterlyPlan.price, 3999, "Quarterly plan price must be ₹3,999.");

  // 4b. No fake renewal date fallback in getUserSubscription
  const mockSubClient = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: {
                  status: "active",
                  current_period_end: null, // No real renewal date stored
                  cancel_at_period_end: false,
                  plan_id: "monthly",
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const subResult = await getUserSubscription("user-no-date", mockSubClient as any);
  assert.strictEqual(
    subResult?.currentPeriodEnd,
    undefined,
    "getUserSubscription must NOT fabricate a fake 30-day future date when current_period_end is null."
  );

  // 4c. Real renewal date is preserved when present
  const mockSubClientReal = {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: {
                  status: "active",
                  current_period_end: "2026-12-31T23:59:59Z",
                  cancel_at_period_end: false,
                  plan_id: "monthly",
                },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const subResultReal = await getUserSubscription("user-real-date", mockSubClientReal as any);
  assert.strictEqual(
    subResultReal?.currentPeriodEnd,
    new Date("2026-12-31T23:59:59Z").toISOString(),
    "getUserSubscription must preserve real current_period_end date."
  );

  // 4d. Source code audit: ensure no hardcoded legacy strings remain
  const settingsSource = fs.readFileSync(path.join(__dirname, "../src/app/settings/page.tsx"), "utf8");
  assert.ok(
    !settingsSource.includes("Rs 199 / month"),
    "src/app/settings/page.tsx must NOT contain hardcoded 'Rs 199 / month'."
  );
  assert.ok(
    !settingsSource.includes("12/14/2026"),
    "src/app/settings/page.tsx must NOT contain hardcoded date '12/14/2026'."
  );
  assert.ok(
    !settingsSource.includes("$9 / month"),
    "src/app/settings/page.tsx must NOT contain hardcoded '$9 / month'."
  );

  console.log("  ✓ Billing settings catalog and subscription checks passed.\n");

  // ---------------------------------------------------------------------------
  // TEST 5: SQL Migration Verification
  // ---------------------------------------------------------------------------
  console.log("Test 5: Verifying SQL migration idempotency and structure...");

  const migrationPath = path.join(
    __dirname,
    "../supabase/migrations/20261114b_profiles_onboarding_completed_at.sql"
  );
  assert.ok(fs.existsSync(migrationPath), "Migration file 20261114b_profiles_onboarding_completed_at.sql must exist.");
  const sql = fs.readFileSync(migrationPath, "utf8");

  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS public.profiles"), "SQL must create profiles table if not exists.");
  assert.ok(sql.includes("ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_completed_at"), "SQL must add onboarding_completed_at column if not exists.");
  assert.ok(sql.includes("ENABLE ROW LEVEL SECURITY"), "SQL must enable RLS on profiles.");
  assert.ok(sql.includes("candidate_profiles"), "SQL must backfill from candidate_profiles.");
  assert.ok(sql.includes("user_preferences"), "SQL must backfill from user_preferences.");
  assert.ok(sql.includes("ROLLBACK"), "SQL must contain explicit rollback instructions.");

  console.log("  ✓ SQL migration structure and safety checks passed.\n");

  console.log("================================================================================");
  console.log("  ALL TESTS PASSED: Onboarding persistence, repeat login guard & billing valid. ");
  console.log("================================================================================");
}

// -----------------------------------------------------------------------------
// Runner & Subprocess Negative Control Execution
// -----------------------------------------------------------------------------
if (!isNegativeControl) {
  runOnboardingSuite()
    .then(() => {
      console.log("\nRunning subprocess negative control check (--negative-control)...");
      const selfPath = __filename;
      const result = spawnSync(process.execPath, ["-r", "tsx/cjs", selfPath, "--negative-control"], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "test" },
      });

      assert.notStrictEqual(
        result.status,
        0,
        `Negative control must exit with non-zero code. Received status: ${result.status}`
      );
      console.log("  ✓ Negative control verified: failed with non-zero exit as expected.");
      console.log("\nDone.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("\nTEST FAILED:", err);
      process.exit(1);
    });
} else {
  runOnboardingSuite().catch(() => {
    process.exit(1);
  });
}
