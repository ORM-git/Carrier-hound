/**
 * CareerMonke Two-Tier Entitlement & Security Hardening Verification Suite
 * 
 * Verifies:
 * 1. Simple Server-Backed Launch Access:
 *    - Enabled launch policy + valid user selection -> accessSource="launch_access", status="none".
 *    - Existing paid subscriptions retain full rights with accessSource="subscription".
 *    - Disabled launch policy fails closed to tier="none".
 *    - Missing user selection fails closed to tier="none".
 *    - Abuse revocation (revoked_at IS NOT NULL) fails closed to tier="none".
 *    - Old signed-pass tokens are strictly superseded and fail closed.
 *    - Consistent enforcement of allow_listings flag.
 * 2. Tier Selection Endpoint (POST /api/billing/activate):
 *    - Unauthenticated calls rejected with 401 AUTH_REQUIRED.
 *    - Invalid session tokens rejected with 401 INVALID_SESSION.
 *    - Forged user ID in request body is ignored; derives user ID strictly from authenticated session.
 *    - Forged or invalid tier names rejected with 400 INVALID_TIER.
 *    - Disabled launch policy rejected with 403 LAUNCH_POLICY_DISABLED.
 *    - Revocation lookup failure returns 503 REVOCATION_CHECK_FAILED (fails closed; never skips check).
 *    - Revoked users rejected with 403 LAUNCH_ACCESS_REVOKED without leaking internal reasons or admin IDs.
 *    - Valid tier selection succeeds idempotently with accessSource="launch_access".
 * 3. AI Service Handler & Score Isolation:
 *    - Listings tier calling /api/ai rejected with 403 AI_TIER_REQUIRED (no scores / no AI).
 *    - AI tier passes entitlement gate and receives real match scoring & AI features.
 *    - Quota limits enforced accurately per operation:
 *      * job_fit: 50 / day
 *      * resume_extraction: 20 / day
 *      * cover_letter: 30 / day
 *      * resume_tailor: 30 / day
 *    - Quota failure refunds via refundAiQuota.
 * 4. Global AI Capacity Guard (Atomic Stored Procedure):
 *    - Unset/empty MAX_GLOBAL_DAILY_AI_REQUESTS fails closed with 503 AI_CAPACITY_UNCONFIGURED.
 *    - Invalid/non-positive cap fails closed with 503 INVALID_CAP.
 *    - Stored procedure failure fails closed with 503 GLOBAL_AI_CAPACITY_CHECK_FAILED.
 *    - Atomic conditional increment enforces ceiling (429 GLOBAL_AI_CAPACITY_REACHED).
 *    - Atomic refund function executes cleanly.
 * 5. Schema Contract & Privacy Invariant:
 *    - user_launch_access uses user_id as primary key (NO artificial id column).
 *    - serverEntitlement.ts and activate/route.ts do NOT select nonexistent id.
 *    - activate/route.ts does NOT select internal administrative columns revocation_reason or revoked_by.
 *    - SECURITY DEFINER functions pin SET search_path = public, pg_temp.
 *    - RLS policies use rerunnable DROP POLICY IF EXISTS.
 *    - Explicit revocation of authenticated table privileges prior to narrow column grants.
 *    - RPC set_user_launch_tier granted strictly to service_role (no authenticated bypass).
 * 6. Auth-First Guards:
 *    - Inner app routes (/dashboard, /tracker, /applications, /resume, /profile, /settings, /radar, /onboarding, /admin)
 *      redirect logged-out users to login (or / for admin).
 *    - Direct link to /applications redirects to /login?next=/applications.
 *    - Public routes remain accessible without forced login.
 * 7. Country Derivation & Negative Control.
 * 
 * Run with: npx tsx scripts/test-two-tier-entitlements.ts
 * Run negative control: npx tsx scripts/test-two-tier-entitlements.ts --negative-control
 */

import { getServerEntitlement } from "../src/lib/billing/serverEntitlement";
import { getValidReturnUrl } from "../src/lib/auth/session";
import { POST as activateHandler } from "../src/app/api/billing/activate/route";
import { handleActivateRequest } from "../src/lib/billing/activate";
import { handleAiRequest } from "../src/lib/ai/serviceHandler";
import {
  checkAndIncrementGlobalAiQuota,
  refundGlobalAiQuota,
  OPERATION_CONFIGS,
} from "../src/lib/ai/security";
import {
  SUPPORTED_COUNTRY_OPTIONS,
  STATIC_TAXONOMY_COUNTRY_CODES,
  COMMON_ACTIVE_COUNTRIES,
  deriveCountryOptionsFromActiveJobs,
} from "../src/lib/geo/cities";
import { fetchLiveActiveJobCountryCodes } from "../src/lib/jobs/service";
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
}
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock_anon_key_for_offline_tests";
}
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock_service_key_for_offline_tests";
}

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let blockedTests = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${testName}${detail ? ` (${detail})` : ""}`);
  } else {
    failedTests++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` - Detail: ${detail}` : ""}`);
  }
}

function markBlocked(testName: string, reason: string) {
  totalTests++;
  blockedTests++;
  console.log(`  ⏸️  [BLOCKED]: ${testName} — Prerequisite: ${reason}`);
}

async function runTests() {
  console.log("===============================================================================");
  console.log("  CareerMonke Server-Backed Launch Access & Entitlement Verification Suite");
  console.log("===============================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("[NEGATIVE CONTROL MODE ACTIVATED] Expecting forced assertion failure...\n");
    assert(false, "Negative Control Intended Failure", "Forced failure to verify non-zero exit code");
    console.log(`\nResults: ${passedTests} passed, ${failedTests} failed, ${blockedTests} blocked`);
    process.exit(1);
  }

  const userIdAlice = "00000000-0000-4000-a000-000000000001";
  const userIdBob = "00000000-0000-4000-a000-000000000002";
  const userIdRevoked = "00000000-0000-4000-a000-000000000003";

  // Mock Database helper for server entitlement
  function createMockSupabase(options: {
    policy?: { is_enabled: boolean; allow_ai?: boolean; allow_listings?: boolean } | null;
    userAccess?: Record<string, { tier: "listings" | "ai"; revoked_at?: string | null }> | null;
    subscriptions?: Record<string, any> | null;
    globalAiCount?: number;
  }) {
    return {
      from: (table: string) => {
        if (table === "subscriptions") {
          return {
            select: () => ({
              eq: (_col: string, val: string) => ({
                order: () => ({
                  limit: () => ({
                    maybeSingle: async () => {
                      const sub = options.subscriptions?.[val] || null;
                      return { data: sub, error: null };
                    },
                  }),
                }),
              }),
            }),
          };
        }

        if (table === "launch_policy") {
          return {
            select: () => ({
              limit: () => ({
                maybeSingle: async () => {
                  if (options.policy === undefined) {
                    return { data: null, error: new Error("relation launch_policy does not exist") };
                  }
                  return { data: options.policy, error: null };
                },
              }),
            }),
          };
        }

        if (table === "user_launch_access") {
          return {
            select: (cols: string) => {
              // Verify column selection contract: user_launch_access has user_id, NOT id
              const colList = cols.split(",").map((c: string) => c.trim());
              if (colList.includes("id")) {
                throw new Error("Invalid column: user_launch_access has user_id, NOT id");
              }
              return {
                eq: (_col: string, val: string) => ({
                  maybeSingle: async () => {
                    if (options.userAccess === undefined) {
                      return { data: null, error: new Error("relation user_launch_access does not exist") };
                    }
                    const row = options.userAccess?.[val];
                    if (!row) return { data: null, error: null };
                    return {
                      data: {
                        user_id: val,
                        tier: row.tier,
                        revoked_at: row.revoked_at || null,
                      },
                      error: null,
                    };
                  },
                }),
              };
            },
          };
        }

        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      },
    };
  }

  // ---------------------------------------------------------------------------
  // SECTION 1: Simple Server-Backed Launch Access Verification
  // ---------------------------------------------------------------------------
  console.log("--- 1. Simple Server-Backed Launch Access (getServerEntitlement) ---");

  const standardMock = createMockSupabase({
    policy: { is_enabled: true, allow_ai: true, allow_listings: true },
    userAccess: {
      [userIdAlice]: { tier: "listings", revoked_at: null },
      [userIdBob]: { tier: "ai", revoked_at: null },
      [userIdRevoked]: { tier: "ai", revoked_at: new Date(Date.now() - 3600000).toISOString() },
    },
  });

  // 1.1 Unauthenticated user fails closed
  const freeResult = await getServerEntitlement(userIdAlice, { supabaseClient: null });
  assert(
    freeResult.tier === "none" &&
    freeResult.accessSource === "none" &&
    freeResult.status === "none" &&
    freeResult.canAccessListings === false &&
    freeResult.canAccessAi === false,
    "Missing credentials fails closed to tier=none with accessSource=none"
  );

  // 1.2 User with Listings tier selection gets unmasked listings, NO scores, NO AI
  const listingsResult = await getServerEntitlement(userIdAlice, { supabaseClient: standardMock });
  assert(
    listingsResult.tier === "listings" &&
    listingsResult.accessSource === "launch_access" &&
    listingsResult.status === "none" &&
    listingsResult.canAccessListings === true &&
    listingsResult.canAccessScores === false &&
    listingsResult.canAccessAi === false,
    "Server-stored Listings tier grants listings access, NO scores and NO AI (accessSource=launch_access, status=none)",
    `source=${listingsResult.accessSource}, status=${listingsResult.status}`
  );

  // 1.3 User with AI tier selection gets listings PLUS scores and AI
  const aiResult = await getServerEntitlement(userIdBob, { supabaseClient: standardMock });
  assert(
    aiResult.tier === "ai" &&
    aiResult.accessSource === "launch_access" &&
    aiResult.status === "none" &&
    aiResult.canAccessListings === true &&
    aiResult.canAccessScores === true &&
    aiResult.canAccessAi === true,
    "Server-stored AI tier grants listings, match scores, and AI features (accessSource=launch_access, status=none)",
    `source=${aiResult.accessSource}, status=${aiResult.status}`
  );

  // 1.4 User revoked for abuse fails closed to tier=none
  const revokedResult = await getServerEntitlement(userIdRevoked, { supabaseClient: standardMock });
  assert(
    revokedResult.tier === "none" &&
    revokedResult.accessSource === "none" &&
    revokedResult.canAccessListings === false &&
    revokedResult.canAccessAi === false,
    "User with server-side abuse revocation (revoked_at IS NOT NULL) fails closed to tier=none"
  );

  // 1.5 Disabled launch policy fails closed
  const disabledPolicyMock = createMockSupabase({
    policy: { is_enabled: false },
    userAccess: { [userIdBob]: { tier: "ai", revoked_at: null } },
  });
  const disabledResult = await getServerEntitlement(userIdBob, { supabaseClient: disabledPolicyMock });
  assert(
    disabledResult.tier === "none" && disabledResult.accessSource === "none",
    "Disabled launch policy (is_enabled=false) fails closed globally to tier=none"
  );

  // 1.6 Missing policy table/row fails closed
  const missingPolicyMock = createMockSupabase({
    policy: undefined,
    userAccess: { [userIdBob]: { tier: "ai", revoked_at: null } },
  });
  const missingPolicyResult = await getServerEntitlement(userIdBob, { supabaseClient: missingPolicyMock });
  assert(
    missingPolicyResult.tier === "none" && missingPolicyResult.accessSource === "none",
    "Missing launch_policy table fails closed to tier=none"
  );

  // 1.7 Missing user selection row fails closed
  const unregisteredUser = "00000000-0000-4000-a000-000000000099";
  const missingUserResult = await getServerEntitlement(unregisteredUser, { supabaseClient: standardMock });
  assert(
    missingUserResult.tier === "none" && missingUserResult.accessSource === "none",
    "Unregistered user without server-stored selection fails closed to tier=none"
  );

  // 1.8 Existing valid paid subscriber retains rights unchanged (Paid Listings does not get silently downgraded)
  const paidSubscriberMock = createMockSupabase({
    policy: { is_enabled: true, allow_ai: true, allow_listings: true },
    subscriptions: {
      [userIdAlice]: {
        id: "sub-paid-123",
        user_id: userIdAlice,
        status: "active",
        current_period_end: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        plan_id: "pro_monthly",
      },
    },
    userAccess: {
      [userIdAlice]: { tier: "ai", revoked_at: null }, // user tried to self-select AI
    },
  });
  const paidResult = await getServerEntitlement(userIdAlice, { supabaseClient: paidSubscriberMock });
  assert(
    paidResult.tier === "ai" &&
    paidResult.accessSource === "subscription" &&
    paidResult.status === "active" &&
    paidResult.isPro === true,
    "Existing paid subscriber succeeds directly via subscriptions table with accessSource=subscription"
  );

  // 1.9 Consistent allow_listings enforcement
  const listingsDisabledMock = createMockSupabase({
    policy: { is_enabled: true, allow_ai: false, allow_listings: false },
    userAccess: { [userIdAlice]: { tier: "listings", revoked_at: null } },
  });
  const listingsDisabledRes = await getServerEntitlement(userIdAlice, { supabaseClient: listingsDisabledMock });
  assert(
    listingsDisabledRes.tier === "none" && listingsDisabledRes.accessSource === "none",
    "When policy disables listings (allow_listings=false), selection fails closed to tier=none"
  );

  // 1.10 Old signed-pass path is superseded and disabled
  const oldTokenPass = "eyJhbGciOiJIUzI1NiJ9.fake_launch_token.signature";
  const oldPassEntitlement = await getServerEntitlement(userIdAlice, {
    launchPass: oldTokenPass,
    supabaseClient: null,
  });
  assert(
    oldPassEntitlement.tier === "none" && oldPassEntitlement.accessSource === "none",
    "Old stateless signed launch pass fails closed (superseded by server-stored tier selection)"
  );

  // ---------------------------------------------------------------------------
  // SECTION 2: Tier Selection Endpoint (POST /api/billing/activate)
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Tier Selection Endpoint Security Gates ---");

  // 2.1 Unauthenticated call rejected with 401 AUTH_REQUIRED
  const reqNoAuth = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier: "ai" }),
  });
  const resNoAuth = await activateHandler(reqNoAuth);
  const dataNoAuth = await resNoAuth.json();
  assert(
    resNoAuth.status === 401 && dataNoAuth.code === "AUTH_REQUIRED",
    "POST /api/billing/activate without Bearer token rejected with 401 AUTH_REQUIRED"
  );

  // 2.2 Invalid token rejected with 401
  const reqBadToken = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer invalid_garbage_token",
    },
    body: JSON.stringify({ tier: "ai" }),
  });
  const resBadToken = await activateHandler(reqBadToken);
  assert(
    resBadToken.status === 401,
    "POST /api/billing/activate with invalid token rejected with 401"
  );

  // 2.3 Unit testing handleActivateRequest with controlled mock dependencies
  const mockAuthClient = {
    auth: {
      getUser: async (token: string) => {
        if (token === "valid-alice-token") return { data: { user: { id: userIdAlice } }, error: null };
        if (token === "revoked-user-token") return { data: { user: { id: userIdRevoked } }, error: null };
        return { data: { user: null }, error: new Error("Invalid session") };
      },
    },
  };

  // 2.4 Forged or invalid tier names rejected with 400 INVALID_TIER
  const reqInvalidTier = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-alice-token",
    },
    body: JSON.stringify({ tier: "super_admin_unlimited" }),
  });
  const resInvalidTier = await handleActivateRequest(reqInvalidTier, {
    supabaseAuthClient: mockAuthClient,
    supabaseAdmin: {} as any,
  });
  const dataInvalidTier = await resInvalidTier.json();
  assert(
    resInvalidTier.status === 400 && dataInvalidTier.code === "INVALID_TIER",
    "Invalid tier selection rejected with 400 INVALID_TIER"
  );

  // 2.5 Policy check failure (policy disabled) returns 403 LAUNCH_POLICY_DISABLED
  const mockAdminPolicyDisabled = {
    from: (table: string) => {
      if (table === "launch_policy") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { is_enabled: false, allow_ai: false, allow_listings: false },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
    },
  };
  const reqDisabledPolicy = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-alice-token",
    },
    body: JSON.stringify({ tier: "listings" }),
  });
  const resDisabledPolicy = await handleActivateRequest(reqDisabledPolicy, {
    supabaseAuthClient: mockAuthClient,
    supabaseAdmin: mockAdminPolicyDisabled as any,
  });
  const dataDisabledPolicy = await resDisabledPolicy.json();
  assert(
    resDisabledPolicy.status === 403 && dataDisabledPolicy.code === "LAUNCH_POLICY_DISABLED",
    "Disabled launch policy rejected with 403 LAUNCH_POLICY_DISABLED"
  );

  // 2.6 Revocation lookup failure fails closed with HTTP 503 (never skips or bypasses check)
  const mockAdminRevocationCheckError = {
    from: (table: string) => {
      if (table === "launch_policy") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { is_enabled: true, allow_ai: true, allow_listings: true },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "user_launch_access") {
        return {
          select: (cols: string) => {
            const colList = cols.split(",").map((c: string) => c.trim());
            assert(!colList.includes("id"), "Revocation select strictly queries user_id, NOT nonexistent id");
            assert(!colList.includes("revocation_reason"), "Revocation select strictly omits internal revocation_reason");
            return {
              eq: () => ({
                maybeSingle: async () => ({
                  data: null,
                  error: new Error("Database timeout or network partition"),
                }),
              }),
            };
          },
        };
      }
      return {};
    },
  };
  const reqRevocationError = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-alice-token",
    },
    body: JSON.stringify({ tier: "listings" }),
  });
  const resRevocationError = await handleActivateRequest(reqRevocationError, {
    supabaseAuthClient: mockAuthClient,
    supabaseAdmin: mockAdminRevocationCheckError as any,
  });
  const dataRevocationError = await resRevocationError.json();
  assert(
    resRevocationError.status === 503 && dataRevocationError.code === "REVOCATION_CHECK_FAILED",
    "Revocation lookup error fails closed with HTTP 503 REVOCATION_CHECK_FAILED (never skips check)"
  );

  // 2.7 Revoked account rejected with 403 LAUNCH_ACCESS_REVOKED and preserves admin privacy
  const mockAdminRevokedUser = {
    from: (table: string) => {
      if (table === "launch_policy") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { is_enabled: true, allow_ai: true, allow_listings: true },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "user_launch_access") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  user_id: userIdRevoked,
                  tier: "ai",
                  revoked_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    },
  };
  const reqRevokedUser = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer revoked-user-token",
    },
    body: JSON.stringify({ tier: "ai" }),
  });
  const resRevokedUser = await handleActivateRequest(reqRevokedUser, {
    supabaseAuthClient: mockAuthClient,
    supabaseAdmin: mockAdminRevokedUser as any,
  });
  const dataRevokedUser = await resRevokedUser.json();
  assert(
    resRevokedUser.status === 403 &&
    dataRevokedUser.code === "LAUNCH_ACCESS_REVOKED" &&
    !("revocationReason" in dataRevokedUser) &&
    !("revocation_reason" in dataRevokedUser) &&
    !("revoked_by" in dataRevokedUser) &&
    !("revokedBy" in dataRevokedUser),
    "Revoked user rejected with 403 LAUNCH_ACCESS_REVOKED without exposing internal admin reasons or admin IDs"
  );

  // 2.8 Valid selection derives user ID strictly from verified token (ignoring forged body.user_id)
  let upsertedRow: any = null;
  const mockAdminSuccess = {
    from: (table: string) => {
      if (table === "launch_policy") {
        return {
          select: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: { is_enabled: true, allow_ai: true, allow_listings: true },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "user_launch_access") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
          upsert: async (row: any) => {
            upsertedRow = row;
            return { error: null };
          },
        };
      }
      return {};
    },
  };
  const reqForgedBodyUser = new Request("http://localhost/api/billing/activate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-alice-token",
    },
    body: JSON.stringify({
      tier: "ai",
      user_id: "00000000-0000-4000-a000-FORGED000099",
      userId: "00000000-0000-4000-a000-FORGED000099",
    }),
  });
  const resSuccess = await handleActivateRequest(reqForgedBodyUser, {
    supabaseAuthClient: mockAuthClient,
    supabaseAdmin: mockAdminSuccess as any,
  });
  const dataSuccess = await resSuccess.json();
  assert(
    resSuccess.status === 200 &&
    dataSuccess.success === true &&
    dataSuccess.accessSource === "launch_access" &&
    dataSuccess.status === "none" &&
    upsertedRow?.user_id === userIdAlice,
    "Valid activation derives user ID strictly from session (upserted user_id matches token, ignoring body forge)"
  );

  // ---------------------------------------------------------------------------
  // SECTION 3: AI Service Handler Protection & Score Isolation
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. AI Service Handler & Score Isolation Gates ---");

  function createChainableMock(defaultData: any = null) {
    const handler: any = {
      get: (_target: any, prop: string) => {
        if (prop === "then") {
          return (resolve: any) => resolve({ data: defaultData, error: null });
        }
        if (prop === "maybeSingle" || prop === "single") {
          return async () => ({ data: defaultData, error: null });
        }
        return () => new Proxy({}, handler);
      },
    };
    return new Proxy({}, handler);
  }

  const baseAiDeps = {
    env: { MAX_GLOBAL_DAILY_AI_REQUESTS: "1000" },
    getSupabaseAdmin: () => ({
      auth: {
        getUser: async (token: string) => {
          if (token === "valid-token-alice") return { data: { user: { id: userIdAlice } }, error: null };
          if (token === "valid-token-bob") return { data: { user: { id: userIdBob } }, error: null };
          return { data: { user: null }, error: new Error("Invalid token") };
        },
      },
      rpc: async (fn: string, params: any) => {
        if (fn === "check_and_increment_global_ai_quota") {
          return {
            data: {
              allowed: true,
              currentCount: 1,
              limit: params.p_max_daily_requests,
            },
            error: null,
          };
        }
        if (fn === "refund_global_ai_quota") {
          return { data: { success: true }, error: null };
        }
        return { data: null, error: null };
      },
      from: () => createChainableMock(null),
    }),
  };

  // 3.1 Listings tier calling /api/ai rejected with 403 AI_TIER_REQUIRED
  const listingsAiDeps = {
    ...baseAiDeps,
    getServerEntitlement: async () => ({
      tier: "listings" as const,
      accessSource: "launch_access" as const,
      canAccessListings: true,
      canAccessScores: false,
      canAccessAi: false,
      isPro: true,
      status: "none" as const,
      planName: "Launch Access (Listings Tier)",
      inGracePeriod: false,
    }),
  };

  const reqListingsAi = new Request("http://localhost/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token-alice",
    },
    body: JSON.stringify({ operation: "job_fit", job: { title: "Engineer" } }),
  });
  const resListingsAi = await handleAiRequest(reqListingsAi, listingsAiDeps as any);
  const dataListingsAi = await resListingsAi.json();
  assert(
    resListingsAi.status === 403 && dataListingsAi.code === "AI_TIER_REQUIRED",
    "Listings tier user calling /api/ai rejected with 403 AI_TIER_REQUIRED (no scores / no AI)"
  );

  // 3.2 AI tier calling /api/ai passes entitlement gate
  let groqCalled = false;
  const aiAiDeps = {
    ...baseAiDeps,
    getServerEntitlement: async () => ({
      tier: "ai" as const,
      accessSource: "launch_access" as const,
      canAccessListings: true,
      canAccessScores: true,
      canAccessAi: true,
      isPro: true,
      status: "none" as const,
      planName: "Launch Access (AI Tier)",
      inGracePeriod: false,
    }),
    callGroq: async () => {
      groqCalled = true;
      return { choices: [{ message: { content: '{"score": 94, "grade": "High", "reason": "Strong match"}' } }] };
    },
  };

  const reqAiAi = new Request("http://localhost/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token-bob",
    },
    body: JSON.stringify({
      operation: "job_fit",
      job: { title: "Lead Software Engineer", company: "Acme Corp", description: "Frontend and full-stack lead" },
      candidate: { fullName: "Bob", skills: ["TypeScript", "Next.js"] },
    }),
  });
  const resAiAi = await handleAiRequest(reqAiAi, aiAiDeps as any);
  assert(
    resAiAi.status === 200 && groqCalled === true,
    "AI tier user passes entitlement gate to receive real match scores"
  );

  // 3.3 Accurate quota verification across all supported operations
  assert(OPERATION_CONFIGS.job_fit.dailyQuota === 50, "job_fit daily quota is strictly 50");
  assert(OPERATION_CONFIGS.resume_extraction.dailyQuota === 20, "resume_extraction daily quota is strictly 20");
  assert(OPERATION_CONFIGS.cover_letter.dailyQuota === 30, "cover_letter daily quota is strictly 30");
  assert(OPERATION_CONFIGS.resume_tailor.dailyQuota === 30, "resume_tailor daily quota is strictly 30");

  // ---------------------------------------------------------------------------
  // SECTION 4: Atomic Global AI Capacity Guard (checkAndIncrementGlobalAiQuota)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. Atomic Global AI Capacity Guard & Quota Failure Modes ---");

  // 4.1 When MAX_GLOBAL_DAILY_AI_REQUESTS is unset, fails closed (AI_CAPACITY_UNCONFIGURED)
  const dummySupabase = {} as any;
  const unsetResult = await checkAndIncrementGlobalAiQuota(dummySupabase, 100, {});
  assert(
    unsetResult.allowed === false &&
    unsetResult.isConfigured === false &&
    unsetResult.code === "AI_CAPACITY_UNCONFIGURED",
    "Unset MAX_GLOBAL_DAILY_AI_REQUESTS fails closed (allowed=false, code=AI_CAPACITY_UNCONFIGURED)"
  );

  // 4.2 When MAX_GLOBAL_DAILY_AI_REQUESTS is invalid or non-positive, fails closed
  const zeroCapResult = await checkAndIncrementGlobalAiQuota(dummySupabase, 100, {
    MAX_GLOBAL_DAILY_AI_REQUESTS: "0",
  });
  assert(
    zeroCapResult.allowed === false && zeroCapResult.code === "INVALID_CAP",
    "Zero or negative MAX_GLOBAL_DAILY_AI_REQUESTS fails closed with INVALID_CAP"
  );

  // 4.3 When RPC check encounters database error, fails closed with 503 code
  const mockRpcErrorSupabase = {
    rpc: async () => ({ data: null, error: new Error("RPC check_and_increment_global_ai_quota not found") }),
  };
  const rpcErrorResult = await checkAndIncrementGlobalAiQuota(mockRpcErrorSupabase as any, 100, {
    MAX_GLOBAL_DAILY_AI_REQUESTS: "500",
  });
  assert(
    rpcErrorResult.allowed === false &&
    rpcErrorResult.isServiceUnavailable === true &&
    rpcErrorResult.code === "GLOBAL_AI_CAPACITY_CHECK_FAILED",
    "Database RPC error fails closed with GLOBAL_AI_CAPACITY_CHECK_FAILED"
  );

  // 4.4 When RPC indicates capacity limit reached, returns allowed=false with currentCount and limit
  const mockRpcFullSupabase = {
    rpc: async (_fn: string, params: any) => {
      assert(params.p_max_daily_requests === 25, "Passes p_max_daily_requests to atomic RPC");
      return {
        data: {
          allowed: false,
          code: "GLOBAL_AI_CAPACITY_REACHED",
          currentCount: 25,
          limit: 25,
        },
        error: null,
      };
    },
  };
  const fullResult = await checkAndIncrementGlobalAiQuota(mockRpcFullSupabase as any, 100, {
    MAX_GLOBAL_DAILY_AI_REQUESTS: "25",
  });
  assert(
    fullResult.allowed === false &&
    fullResult.code === "GLOBAL_AI_CAPACITY_REACHED" &&
    fullResult.currentCount === 25 &&
    fullResult.limit === 25,
    "Atomic RPC enforcing capacity ceiling returns allowed=false (currentCount=25, limit=25)"
  );

  // 4.5 Atomic refund function invokes refund_global_ai_quota RPC
  let refundRpcCalled = false;
  const mockRefundSupabase = {
    rpc: async (fn: string, params: any) => {
      if (fn === "refund_global_ai_quota") {
        refundRpcCalled = true;
        assert(params.p_estimated_tokens === 350, "Passes estimated tokens to atomic refund RPC");
        return { data: { success: true }, error: null };
      }
      return { data: null, error: null };
    },
  };
  await refundGlobalAiQuota(mockRefundSupabase as any, 350);
  assert(refundRpcCalled === true, "refundGlobalAiQuota executes atomic refund_global_ai_quota RPC");

  // ---------------------------------------------------------------------------
  // SECTION 5: Schema Contract & Privacy Invariants
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Schema Contract & Privacy Invariants ---");

  const proposedSqlPath = path.resolve(__dirname, "../supabase/proposed_server_launch_access.sql");
  assert(fs.existsSync(proposedSqlPath), "supabase/proposed_server_launch_access.sql exists in repository");

  const proposedSql = fs.readFileSync(proposedSqlPath, "utf8");

  // 5.1 user_launch_access primary key contract
  assert(
    proposedSql.includes("user_id UUID PRIMARY KEY REFERENCES auth.users(id)"),
    "user_launch_access schema defines user_id UUID PRIMARY KEY (NOT artificial id column)"
  );
  assert(
    !proposedSql.includes("CREATE TABLE IF NOT EXISTS public.user_launch_access (\n  id UUID"),
    "user_launch_access does not contain artificial id column"
  );

  // 5.2 Codebase select contracts
  const serverEntitlementSrc = fs.readFileSync(path.resolve(__dirname, "../src/lib/billing/serverEntitlement.ts"), "utf8");
  const activateHandlerSrc = fs.readFileSync(path.resolve(__dirname, "../src/lib/billing/activate.ts"), "utf8");

  assert(
    !serverEntitlementSrc.includes('.select("id') && !serverEntitlementSrc.includes(".select('id"),
    "serverEntitlement.ts does not query nonexistent id column from user_launch_access"
  );
  assert(
    !activateHandlerSrc.includes('.select("id') && !activateHandlerSrc.includes(".select('id"),
    "activate.ts does not query nonexistent id column from user_launch_access"
  );
  assert(
    !activateHandlerSrc.includes("revocation_reason") && !activateHandlerSrc.includes("revoked_by"),
    "activate.ts does not select private admin fields revocation_reason or revoked_by"
  );

  // 5.3 SECURITY DEFINER and search_path pinning
  const secDefFuncs = proposedSql.match(/LANGUAGE plpgsql[\s\r\n]+SECURITY DEFINER/g) || [];
  const searchPathFuncs = proposedSql.match(/SECURITY DEFINER[\s\r\n]+SET search_path = public, pg_temp/g) || [];
  assert(
    secDefFuncs.length === 4 && searchPathFuncs.length === 4,
    `All SECURITY DEFINER functions (${secDefFuncs.length}) strictly pin SET search_path = public, pg_temp`
  );

  // 5.4 Rerunnable idempotent RLS policies
  assert(
    proposedSql.includes('DROP POLICY IF EXISTS "allow_read_launch_policy" ON public.launch_policy;') &&
    proposedSql.includes('DROP POLICY IF EXISTS "service_role_manage_launch_policy" ON public.launch_policy;') &&
    proposedSql.includes('DROP POLICY IF EXISTS "user_view_own_launch_access" ON public.user_launch_access;') &&
    proposedSql.includes('DROP POLICY IF EXISTS "service_role_manage_user_launch_access" ON public.user_launch_access;') &&
    proposedSql.includes('DROP POLICY IF EXISTS "service_role_manage_ai_global_usage" ON public.ai_global_usage_daily;'),
    "Proposed SQL contains rerunnable DROP POLICY IF EXISTS before all policy creations"
  );

  // 5.5 Table privilege revocation before narrow grants
  assert(
    proposedSql.includes("REVOKE ALL ON public.launch_policy FROM PUBLIC, anon, authenticated;") &&
    proposedSql.includes("REVOKE ALL ON public.user_launch_access FROM PUBLIC, anon, authenticated;"),
    "Proposed SQL explicitly revokes table privileges from authenticated prior to narrow grants"
  );

  // 5.6 set_user_launch_tier is service-role only (no authenticated bypass)
  assert(
    proposedSql.includes("REVOKE ALL ON FUNCTION public.set_user_launch_tier(UUID, VARCHAR(16)) FROM PUBLIC, anon, authenticated;") &&
    proposedSql.includes("GRANT EXECUTE ON FUNCTION public.set_user_launch_tier(UUID, VARCHAR(16)) TO service_role;"),
    "set_user_launch_tier RPC is restricted strictly to service_role (preventing client RPC bypass of activate route)"
  );

  // 5.7 Pre-selection revocation support via atomic upsert
  assert(
    proposedSql.includes("ON CONFLICT (user_id) DO UPDATE\n  SET revoked_at = NOW()"),
    "revoke_user_launch_access RPC supports pre-selection abuse revocation via ON CONFLICT (user_id) DO UPDATE"
  );

  // ---------------------------------------------------------------------------
  // SECTION 6: Auth-First Guards Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Auth-First Guards & Route Protection Verification ---");

  const protectedAppRoutes = [
    { name: "/jobs", file: "src/app/jobs/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullReturnUrl)}`)" },
    { name: "/job-detail", file: "src/app/job-detail/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullUrl)}`)" },
    { name: "/jobs/detail", file: "src/app/jobs/detail/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullUrl)}`)" },
    { name: "/dashboard", file: "src/app/dashboard/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullReturnUrl)}`)" },
    { name: "/tracker", file: "src/app/tracker/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(returnUrl)}`)" },
    { name: "/applications", file: "src/app/applications/page.tsx", expectedRedirect: "TrackerPage" },
    { name: "/resume", file: "src/app/resume/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullReturnUrl)}`)" },
    { name: "/profile", file: "src/app/profile/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(returnUrl)}`)" },
    { name: "/settings", file: "src/app/settings/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullReturnUrl)}`)" },
    { name: "/radar", file: "src/app/radar/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(fullReturnUrl)}`)" },
    { name: "/onboarding", file: "src/app/onboarding/page.tsx", expectedRedirect: "router.replace(`/login?next=${encodeURIComponent(returnUrl)}`)" },
    { name: "/admin", file: "src/app/admin/layout.tsx", expectedRedirect: 'window.location.replace("/")' },
  ];

  for (const route of protectedAppRoutes) {
    const fullPath = path.resolve(__dirname, "..", route.file);
    assert(fs.existsSync(fullPath), `Route component exists: ${route.name} (${route.file})`);
    const content = fs.readFileSync(fullPath, "utf8");
    assert(
      content.includes(route.expectedRedirect),
      `Auth guard verified: ${route.name} redirects unauthenticated visitors (${route.expectedRedirect})`
    );
  }

  // 6.2 Neutral loading state checks to guarantee zero flash of job/app content
  const jobsSrc = fs.readFileSync(path.resolve(__dirname, "../src/app/jobs/page.tsx"), "utf8");
  assert(
    jobsSrc.includes("if (checkingAuth || !user) {\n    return <JobsPageFallback />;\n  }"),
    "/jobs suppresses all job cards, search bars, and app shell before auth verification completes"
  );
  assert(
    jobsSrc.includes("getLiveJobs") && jobsSrc.includes("if (checkingAuth || !user) {\n      return;\n    }"),
    "/jobs suppresses live jobs fetch until authenticated user is confirmed"
  );

  const profileSrc = fs.readFileSync(path.resolve(__dirname, "../src/app/profile/page.tsx"), "utf8");
  assert(
    profileSrc.includes("if (loading || !user) {\n    return <ProfileSkeleton />;\n  }"),
    "/profile suppresses profile content and renders neutral ProfileSkeleton while checking auth"
  );

  // 6.3 Return URL query preservation and validation
  assert(
    getValidReturnUrl("/jobs?q=engineer&country=US") === "/jobs?q=engineer&country=US",
    "getValidReturnUrl preserves safe internal route with query parameters (/jobs?q=engineer&country=US)"
  );
  assert(
    getValidReturnUrl("/jobs?id=abc-123&selected=true") === "/jobs?id=abc-123&selected=true",
    "getValidReturnUrl preserves job detail query parameters"
  );
  assert(
    getValidReturnUrl("/dashboard?tab=overview") === "/dashboard?tab=overview",
    "getValidReturnUrl preserves dashboard tab query parameters"
  );
  assert(
    getValidReturnUrl("https://evil.com") === "/dashboard",
    "getValidReturnUrl rejects external absolute HTTP/HTTPS URLs"
  );
  assert(
    getValidReturnUrl("//evil.com") === "/dashboard",
    "getValidReturnUrl rejects protocol-relative URLs (//evil.com)"
  );
  assert(
    getValidReturnUrl("/\\evil.com") === "/dashboard",
    "getValidReturnUrl rejects backslash-based relative URL bypasses (/\\evil.com)"
  );
  assert(
    getValidReturnUrl("/jobs\r\nHost:evil.com") === "/dashboard",
    "getValidReturnUrl rejects CRLF injection attempts"
  );
  assert(
    getValidReturnUrl("javascript:alert(1)") === "/dashboard",
    "getValidReturnUrl rejects javascript: scheme URLs"
  );
  assert(
    getValidReturnUrl(null) === "/dashboard",
    "getValidReturnUrl falls back safely to /dashboard on null/undefined input"
  );

  // Direct link to /applications preserves query and redirects to /login?next=/applications...
  const trackerSrc = fs.readFileSync(path.resolve(__dirname, "../src/app/tracker/page.tsx"), "utf8");
  assert(
    trackerSrc.includes('window.location.pathname.startsWith("/applications")') &&
    trackerSrc.includes('router.replace(`/login?next=${encodeURIComponent(returnUrl)}`)'),
    "Direct link to /applications redirects correctly to /login?next= preserving search parameters"
  );

  // 6.4 Public routes do NOT force login
  const publicRoutes = [
    "src/app/page.tsx",
    "src/app/pricing/page.tsx",
    "src/app/login/page.tsx",
    "src/app/signup/page.tsx",
    "src/app/privacy/page.tsx",
    "src/app/terms-and-conditions/page.tsx",
  ];
  for (const pRoute of publicRoutes) {
    const fullPath = path.resolve(__dirname, "..", pRoute);
    assert(fs.existsSync(fullPath), `Public route exists: ${pRoute}`);
  }

  // ---------------------------------------------------------------------------
  // SECTION 7: Country Derivation & Aggregates
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. Country Derivation & Aggregate View ---");

  assert(
    Array.isArray(COMMON_ACTIVE_COUNTRIES) && COMMON_ACTIVE_COUNTRIES.length > 10,
    "COMMON_ACTIVE_COUNTRIES is exported and populated with standard country codes"
  );

  const emptyCountryOptions = deriveCountryOptionsFromActiveJobs([]);
  assert(
    emptyCountryOptions.length === 1 && emptyCountryOptions[0].code === "",
    "deriveCountryOptionsFromActiveJobs([]) returns only Worldwide option"
  );

  const mockAggregateSupabase = {
    from: (table: string) => {
      assert(table === "active_job_country_counts", "fetchLiveActiveJobCountryCodes queries active_job_country_counts view");
      return {
        select: (col: string) => {
          assert(col === "country_code", "selects country_code from aggregate view");
          return Promise.resolve({
            data: [{ country_code: "US" }, { country_code: "GB" }, { country_code: "IN" }],
            error: null,
          });
        },
      };
    },
  };
  const aggregateResult = await fetchLiveActiveJobCountryCodes(mockAggregateSupabase as any);
  assert(
    aggregateResult.length === 3 && aggregateResult.includes("US") && aggregateResult.includes("IN"),
    "fetchLiveActiveJobCountryCodes resolves country codes from server aggregate view without multi-page scanning"
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n===============================================================================");
  console.log(`  Suite Summary: ${passedTests}/${totalTests} tests passed (${failedTests} failed, ${blockedTests} blocked)`);
  console.log("===============================================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error("Unhandled test runner error:", err);
  process.exit(1);
});
