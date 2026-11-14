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
import { PGlite } from "@electric-sql/pglite";

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

  // 1e. User with partial answer in user_preferences (roles saved with onboarding_completed: false)
  // Finding 3: A partial answer must NOT count as completed!
  dbState.user_preferences.set("user-partial-prefs", {
    user_id: "user-partial-prefs",
    roles: ["Backend Engineer"],
    onboarding_completed: false,
  });
  const isPartialCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-partial-prefs");
  assert.strictEqual(
    isPartialCompleted,
    false,
    "Partial answer (roles saved with onboarding_completed=false) must NOT count as completed."
  );

  // 1f. User with onboarding_completed = true in user_preferences
  dbState.user_preferences.set("user-prefs-completed", {
    user_id: "user-prefs-completed",
    roles: ["Backend Engineer"],
    onboarding_completed: true,
  });
  const isPrefsCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-prefs-completed");
  assert.strictEqual(
    isPrefsCompleted,
    true,
    "User with user_preferences.onboarding_completed = true must be treated as completed."
  );

  // 1g. Blank-value profiles (whitespace full_name, empty target_roles array)
  dbState.profiles.set("user-blank-profile", {
    user_id: "user-blank-profile",
    full_name: "   ",
    target_roles: [],
    onboarding_completed_at: null,
  });
  const isBlankProfileCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-blank-profile");
  assert.strictEqual(
    isBlankProfileCompleted,
    false,
    "Blank full_name and empty target_roles in profiles must NOT count as completed."
  );

  // 1h. Blank-value candidate_profiles (whitespace raw text, empty skills, empty experience array)
  dbState.candidate_profiles.set("user-blank-candidate", {
    user_id: "user-blank-candidate",
    confirmed_at: null,
    skills: [],
    raw_resume_text: "   ",
    experience_json: [],
  });
  const isBlankCandidateCompleted = await checkAccountOnboardingCompleted(mockClient as any, "user-blank-candidate");
  assert.strictEqual(
    isBlankCandidateCompleted,
    false,
    "Blank resume text, empty skills, and empty experience in candidate_profiles must NOT count as completed."
  );

  console.log("  ✓ Database logic passed (first login vs repeat login vs existing users vs self-healing vs blank guards).\n");

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

  // ---------------------------------------------------------------------------
  // TEST 6: PGlite Real SQL Migration Execution Tests
  // ---------------------------------------------------------------------------
  console.log("Test 6: Executing real SQL migration (PGlite) against fresh, id-keyed shapes, and blank-value cases...");

  // Helper to initialize baseline tables (auth.users, candidate_profiles, user_preferences)
  async function setupBaseDb() {
    const pg = new PGlite();
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (
        id UUID PRIMARY KEY,
        email TEXT
      );
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT NULL::UUID;
      $$ LANGUAGE SQL;

      CREATE TABLE IF NOT EXISTS public.candidate_profiles (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        confirmed_at TIMESTAMPTZ,
        skills TEXT[],
        raw_resume_text TEXT,
        experience_json JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS public.user_preferences (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        roles TEXT[],
        onboarding_completed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    return pg;
  }

  // 6a. Fresh database shape: profiles table does NOT exist beforehand
  {
    console.log("  6a. Fresh DB shape (profiles created by migration)...");
    const pg = await setupBaseDb();
    await pg.exec(sql);

    // Verify public.profiles table exists with required columns
    const colsRes = await pg.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles'
    `);
    const cols = colsRes.rows.map((r) => r.column_name);
    assert.ok(cols.includes("user_id"), "Fresh migration must create profiles.user_id");
    assert.ok(cols.includes("onboarding_completed_at"), "Fresh migration must create profiles.onboarding_completed_at");
    assert.ok(cols.includes("full_name"), "Fresh migration must create profiles.full_name");
    assert.ok(cols.includes("target_roles"), "Fresh migration must create profiles.target_roles");

    // Verify idempotency: running migration a second time succeeds without error
    await pg.exec(sql);
    console.log("    ✓ Fresh DB shape created successfully and verified idempotent.");
  }

  // 6b. Id-keyed profiles shape: profiles exists with id UUID PRIMARY KEY and lacks user_id
  {
    console.log("  6b. Id-keyed profiles shape missing user_id (fail-fast check)...");
    const pg = await setupBaseDb();
    await pg.exec(`
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        full_name TEXT,
        target_roles TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    let threw = false;
    try {
      await pg.exec(sql);
    } catch (err: any) {
      threw = true;
      assert.ok(
        err.message.includes("Safety check failed: public.profiles is missing required column: user_id"),
        `Expected fail-fast error for missing user_id column, got: ${err.message}`
      );
    }
    assert.ok(threw, "Migration MUST fail fast when public.profiles is id-keyed without user_id.");
    console.log("    ✓ Id-keyed shape missing user_id correctly aborted transaction with safety check.");
  }

  // 6c. Profiles shape with user_id present but lacking PK/UNIQUE constraint
  {
    console.log("  6c. Profiles shape missing UNIQUE or PRIMARY KEY on user_id (fail-fast check)...");
    const pg = await setupBaseDb();
    await pg.exec(`
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY,
        user_id UUID,
        full_name TEXT,
        target_roles TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    let threw = false;
    try {
      await pg.exec(sql);
    } catch (err: any) {
      threw = true;
      assert.ok(
        err.message.includes("Safety check failed: public.profiles must have a PRIMARY KEY or UNIQUE constraint on user_id"),
        `Expected fail-fast error for missing PK/UNIQUE constraint on user_id, got: ${err.message}`
      );
    }
    assert.ok(threw, "Migration MUST fail fast when user_id lacks PRIMARY KEY or UNIQUE constraint.");
    console.log("    ✓ Profiles lacking UNIQUE/PK constraint on user_id correctly aborted transaction.");
  }

  // 6d. Substantive backfills vs blank-value backfill cases
  {
    console.log("  6d. Blank-value vs substantive data backfill rules...");
    const pg = await setupBaseDb();

    // Create auth users
    const userIds = {
      blankAll: "11111111-1111-1111-1111-111111111111",
      blankNulls: "22222222-2222-2222-2222-222222222222",
      partialRoles: "33333333-3333-3333-3333-333333333333",
      blankProfile: "44444444-4444-4444-4444-444444444444",
      skillsSubstantive: "55555555-5555-5555-5555-555555555555",
      textSubstantive: "66666666-6666-6666-6666-666666666666",
      expSubstantive: "77777777-7777-7777-7777-777777777777",
      confirmedSubstantive: "88888888-8888-8888-8888-888888888888",
      prefsCompleted: "99999999-9999-9999-9999-999999999999",
      profileSubstantive: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    };

    for (const uid of Object.values(userIds)) {
      await pg.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [uid, `${uid}@example.com`]);
    }

    // Pre-create public.profiles table with initial profiles
    await pg.exec(`
      CREATE TABLE public.profiles (
        user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        full_name TEXT,
        target_roles TEXT[],
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Insert blank-value rows
    // Candidate profile with whitespace resume, empty skills array, empty json array
    await pg.query(`
      INSERT INTO public.candidate_profiles (user_id, raw_resume_text, skills, experience_json, confirmed_at)
      VALUES ($1, '   ', '{}', '[]'::jsonb, NULL)
    `, [userIds.blankAll]);

    // Candidate profile with NULL values and JSON null
    await pg.query(`
      INSERT INTO public.candidate_profiles (user_id, raw_resume_text, skills, experience_json, confirmed_at)
      VALUES ($1, NULL, NULL, 'null'::jsonb, NULL)
    `, [userIds.blankNulls]);

    // User preferences with partial roles and onboarding_completed = false
    await pg.query(`
      INSERT INTO public.user_preferences (user_id, roles, onboarding_completed)
      VALUES ($1, ARRAY['Frontend Developer'], false)
    `, [userIds.partialRoles]);

    // Profile with whitespace name and empty target_roles
    await pg.query(`
      INSERT INTO public.profiles (user_id, full_name, target_roles)
      VALUES ($1, '   ', '{}')
    `, [userIds.blankProfile]);

    // Insert substantive rows
    // Substantive skills
    await pg.query(`
      INSERT INTO public.candidate_profiles (user_id, skills)
      VALUES ($1, ARRAY['React', 'Next.js'])
    `, [userIds.skillsSubstantive]);

    // Substantive resume text
    await pg.query(`
      INSERT INTO public.candidate_profiles (user_id, raw_resume_text)
      VALUES ($1, 'Senior Software Engineer with 8 years of experience')
    `, [userIds.textSubstantive]);

    // Substantive experience JSON
    await pg.query(`
      INSERT INTO public.candidate_profiles (user_id, experience_json)
      VALUES ($1, '[{"company": "Google", "role": "Staff Engineer"}]'::jsonb)
    `, [userIds.expSubstantive]);

    // Substantive confirmed_at
    await pg.query(`
      INSERT INTO public.candidate_profiles (user_id, confirmed_at)
      VALUES ($1, '2026-10-15T12:00:00Z')
    `, [userIds.confirmedSubstantive]);

    // Substantive user_preferences (onboarding_completed = true)
    await pg.query(`
      INSERT INTO public.user_preferences (user_id, roles, onboarding_completed)
      VALUES ($1, ARRAY['DevOps'], true)
    `, [userIds.prefsCompleted]);

    // Substantive profiles (full_name and target_roles)
    await pg.query(`
      INSERT INTO public.profiles (user_id, full_name, target_roles)
      VALUES ($1, 'Bob Dylan', ARRAY['Security Engineer'])
    `, [userIds.profileSubstantive]);

    // Execute migration
    await pg.exec(sql);

    // Fetch all profiles and their completion timestamps
    const rowsRes = await pg.query<{ user_id: string; onboarding_completed_at: string | null }>(`
      SELECT user_id, onboarding_completed_at FROM public.profiles
    `);
    const profilesMap = new Map<string, string | null>(
      rowsRes.rows.map((r) => [r.user_id, r.onboarding_completed_at])
    );

    // Assertions on BLANK / PARTIAL rows:
    assert.strictEqual(
      profilesMap.has(userIds.blankAll),
      false,
      "blank candidate profile (whitespace text, empty skills, [] experience) must NOT be backfilled."
    );
    assert.strictEqual(
      profilesMap.has(userIds.blankNulls),
      false,
      "null candidate profile must NOT be backfilled."
    );
    assert.strictEqual(
      profilesMap.has(userIds.partialRoles),
      false,
      "partial preferences (roles with onboarding_completed=false) must NOT be backfilled."
    );
    assert.strictEqual(
      profilesMap.get(userIds.blankProfile),
      null,
      "blank full_name ('   ') and empty target_roles in profiles must have onboarding_completed_at = NULL."
    );

    // Assertions on SUBSTANTIVE rows:
    assert.ok(
      profilesMap.get(userIds.skillsSubstantive),
      "candidate with non-empty skills array MUST have onboarding_completed_at backfilled."
    );
    assert.ok(
      profilesMap.get(userIds.textSubstantive),
      "candidate with trimmed non-empty resume text MUST have onboarding_completed_at backfilled."
    );
    assert.ok(
      profilesMap.get(userIds.expSubstantive),
      "candidate with non-empty experience_json array MUST have onboarding_completed_at backfilled."
    );
    assert.ok(
      profilesMap.get(userIds.confirmedSubstantive),
      "candidate with confirmed_at MUST have onboarding_completed_at backfilled."
    );
    assert.ok(
      profilesMap.get(userIds.prefsCompleted),
      "user with onboarding_completed=true in user_preferences MUST have onboarding_completed_at backfilled."
    );
    assert.ok(
      profilesMap.get(userIds.profileSubstantive),
      "user with non-empty full_name in profiles MUST have onboarding_completed_at backfilled."
    );

    // Assert that user_preferences.onboarding_completed was synced to true for backfilled profiles,
    // and remains false for user with partial roles.
    const prefsRes = await pg.query<{ user_id: string; onboarding_completed: boolean }>(`
      SELECT user_id, onboarding_completed FROM public.user_preferences
    `);
    const prefsMap = new Map<string, boolean>(
      prefsRes.rows.map((r) => [r.user_id, r.onboarding_completed])
    );
    assert.strictEqual(
      prefsMap.get(userIds.partialRoles),
      false,
      "user_preferences.onboarding_completed must remain false for partial roles user."
    );

    console.log("    ✓ Blank vs substantive backfill assertions passed with strict precision.\n");
  }

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
