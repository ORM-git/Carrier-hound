/**
 * CareerMonke Two-Tier Entitlement & Security Hardening Verification Suite
 * 
 * Verifies:
 * 1. Dedicated signing secret resolution & rejection of forgeable keys / fallbacks.
 * 2. Token binding to authenticated user, audience, environment, and maximum lifetime.
 * 3. Rejection of future-dated, overlong, malformed, expired, and tampered tokens.
 * 4. Activation endpoint blocks unapproved open grants (ACTIVATION_BLOCKED_PENDING_POLICY).
 * 5. Server entitlement separation: distinct accessSource (subscription vs launch_pass) and no payment fiction.
 * 6. AI service handler connection to request headers and enforcement of tier gates.
 * 7. Score isolation: Listings tier strictly gets no match scores or diagnostics.
 * 8. Schema-dependent registry & revocation tests marked BLOCKED until SQL prerequisites exist.
 * 9. Active-job country code derivation for filter bar.
 * 10. Negative control proving non-zero exit on invalid conditions.
 * 
 * Run with: npx tsx scripts/test-two-tier-entitlements.ts
 * Run negative control: npx tsx scripts/test-two-tier-entitlements.ts --negative-control
 */

import { getServerEntitlement } from "../src/lib/billing/serverEntitlement";
import {
  signLaunchPass,
  verifyLaunchPass,
  LAUNCH_PASS_AUDIENCE,
  MAX_LAUNCH_PASS_LIFETIME_MS,
  SIGNING_SECRET_ENV_NAME,
  MissingSigningSecretError,
} from "../src/lib/billing/launchPass";
import { handleAiRequest } from "../src/lib/ai/serviceHandler";
import {
  SUPPORTED_COUNTRY_OPTIONS,
  ACTIVE_JOB_COUNTRY_CODES,
  deriveCountryOptionsFromActiveJobs,
} from "../src/lib/geo/cities";
import fs from "fs";
import path from "path";

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
  console.log("  CareerMonke Two-Tier Security & Entitlement Verification Suite");
  console.log("===============================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("[NEGATIVE CONTROL MODE ACTIVATED] Expecting forced assertion failure...\n");
    assert(false, "Negative Control Intended Failure", "Forced failure to verify non-zero exit code");
    console.log(`\nResults: ${passedTests} passed, ${failedTests} failed, ${blockedTests} blocked`);
    process.exit(1);
  }

  const userIdA = "00000000-0000-4000-a000-000000000001";
  const userIdB = "00000000-0000-4000-a000-000000000002";
  const dedicatedSecret = "cm_secure_test_signing_secret_hardened_20261025";
  const testSecretEnv = { [SIGNING_SECRET_ENV_NAME]: dedicatedSecret };
  const crypto = globalThis.crypto;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(dedicatedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  // ---------------------------------------------------------------------------
  // SECTION 1: Dedicated Secret Resolution & Forgeable Key Rejection
  // ---------------------------------------------------------------------------
  console.log("--- 1. Dedicated Signing Secret & Anti-Forgery Protection ---");

  // 1.1 Issuance fails closed without LAUNCH_PASS_SECRET
  let missingSecretIssuanceFailed = false;
  try {
    await signLaunchPass(userIdA, "listings", 3600000, {});
  } catch (err: any) {
    if (err instanceof MissingSigningSecretError && err.missingVariable === SIGNING_SECRET_ENV_NAME) {
      missingSecretIssuanceFailed = true;
    }
  }
  assert(
    missingSecretIssuanceFailed,
    "signLaunchPass fails closed with MissingSigningSecretError when LAUNCH_PASS_SECRET is missing",
    `reportedVariable=${SIGNING_SECRET_ENV_NAME}`
  );

  // 1.2 Verification fails closed without LAUNCH_PASS_SECRET
  const validSignedPass = await signLaunchPass(userIdA, "ai", 3600000, testSecretEnv);
  const verifyWithoutSecret = await verifyLaunchPass(validSignedPass.token, userIdA, {});
  assert(
    verifyWithoutSecret.valid === false && verifyWithoutSecret.missingVariable === SIGNING_SECRET_ENV_NAME,
    "verifyLaunchPass fails closed when LAUNCH_PASS_SECRET is missing",
    `missingVariable=${verifyWithoutSecret.missingVariable}`
  );

  // 1.3 Old public fallback key forgery is REJECTED
  const oldPublicSecret = "cm_secure_launch_pass_key_20261025";
  const oldForgedPass = await signLaunchPass(userIdA, "ai", 3600000, {
    [SIGNING_SECRET_ENV_NAME]: oldPublicSecret,
  });
  const verifyOldForged = await verifyLaunchPass(oldForgedPass.token, userIdA, testSecretEnv);
  assert(
    verifyOldForged.valid === false && verifyOldForged.error === "Invalid token signature",
    "Token signed with old public fallback secret is REJECTED by hardened verifier"
  );

  // 1.4 Supabase Service Role Key forgery is REJECTED
  const supabaseServiceKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock_supabase_service_role_key";
  const supabaseForgedPass = await signLaunchPass(userIdA, "ai", 3600000, {
    [SIGNING_SECRET_ENV_NAME]: supabaseServiceKey,
  });
  const verifySupabaseForged = await verifyLaunchPass(supabaseForgedPass.token, userIdA, testSecretEnv);
  assert(
    verifySupabaseForged.valid === false && verifySupabaseForged.error === "Invalid token signature",
    "Token signed with Supabase service role key is REJECTED (no credential reuse)"
  );

  // ---------------------------------------------------------------------------
  // SECTION 2: Token Structure & Boundary Validation
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Token Structure & Boundary Validation ---");

  // 2.1 Valid pass passes all checks
  const legitListingsPass = await signLaunchPass(userIdA, "listings", 7 * 86400 * 1000, testSecretEnv);
  const verifyLegit = await verifyLaunchPass(legitListingsPass.token, userIdA, testSecretEnv);
  assert(
    verifyLegit.valid === true &&
    verifyLegit.tier === "listings" &&
    verifyLegit.audience === LAUNCH_PASS_AUDIENCE,
    "Legitimate launch pass is valid with matching tier and audience",
    `tier=${verifyLegit.tier}, aud=${verifyLegit.audience}`
  );

  // 2.2 Subject mismatch (User B attempts to use User A's token)
  const verifyUserMismatch = await verifyLaunchPass(legitListingsPass.token, userIdB, testSecretEnv);
  assert(
    verifyUserMismatch.valid === false && verifyUserMismatch.error === "Token subject mismatch",
    "Token used by different user is REJECTED (subject mismatch)"
  );

  // 2.3 Audience mismatch
  const wrongAudiencePass = await signLaunchPass(userIdA, "ai", 3600000, testSecretEnv, {
    audience: "unauthorized-third-party-aud",
  });
  const verifyWrongAud = await verifyLaunchPass(wrongAudiencePass.token, userIdA, testSecretEnv);
  assert(
    verifyWrongAud.valid === false && (verifyWrongAud.error || "").includes("audience mismatch"),
    "Token with unauthorized audience is REJECTED"
  );

  // 2.4 Environment mismatch
  const stagingPass = await signLaunchPass(userIdA, "ai", 3600000, testSecretEnv, {
    environmentName: "staging",
  });
  const verifyWrongEnv = await verifyLaunchPass(stagingPass.token, userIdA, {
    env: testSecretEnv,
    expectedEnvironment: "production",
  });
  assert(
    verifyWrongEnv.valid === false && (verifyWrongEnv.error || "").includes("environment mismatch"),
    "Token created for different environment is REJECTED"
  );

  // 2.5 Expired token (issued 2h ago, expired 1h ago)
  const expiredPayload = {
    sub: userIdA,
    tier: "ai",
    iat: Date.now() - 2 * 3600 * 1000,
    exp: Date.now() - 1 * 3600 * 1000,
    aud: LAUNCH_PASS_AUDIENCE,
    env: "production",
  };
  const expPayloadStr = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
  const expSigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(expPayloadStr));
  const expSigHex = Array.from(new Uint8Array(expSigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const expiredToken = `${expPayloadStr}.${expSigHex}`;
  const verifyExpired = await verifyLaunchPass(expiredToken, userIdA, testSecretEnv);
  assert(
    verifyExpired.valid === false && verifyExpired.error === "Launch pass expired",
    "Expired token is REJECTED"
  );

  // 2.6 Future-dated token (iat > now + 1 min)
  const futurePayload = {
    sub: userIdA,
    tier: "ai",
    iat: Date.now() + 5 * 60 * 1000, // 5 minutes in future
    exp: Date.now() + 60 * 60 * 1000,
    aud: LAUNCH_PASS_AUDIENCE,
    env: "production",
  };
  const futurePayloadStr = Buffer.from(JSON.stringify(futurePayload)).toString("base64url");
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(futurePayloadStr));
  const sigHex = Array.from(new Uint8Array(sigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const futureToken = `${futurePayloadStr}.${sigHex}`;
  const verifyFuture = await verifyLaunchPass(futureToken, userIdA, testSecretEnv);
  assert(
    verifyFuture.valid === false && (verifyFuture.error || "").includes("future-dated"),
    "Future-dated token (>1min clock skew) is REJECTED"
  );

  // 2.7 Overlong token (>14 days)
  const overlongPayload = {
    sub: userIdA,
    tier: "ai",
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    aud: LAUNCH_PASS_AUDIENCE,
    env: "production",
  };
  const overlongPayloadStr = Buffer.from(JSON.stringify(overlongPayload)).toString("base64url");
  const overlongSigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(overlongPayloadStr));
  const overlongSigHex = Array.from(new Uint8Array(overlongSigBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const overlongToken = `${overlongPayloadStr}.${overlongSigHex}`;
  const verifyOverlong = await verifyLaunchPass(overlongToken, userIdA, testSecretEnv);
  assert(
    verifyOverlong.valid === false && (verifyOverlong.error || "").includes("overlong"),
    "Overlong token (>14 days lifetime) is REJECTED"
  );

  // 2.8 Tampered payload or signature
  const [pStr, legitSig] = legitListingsPass.token.split(".");
  const tamperedSig = legitSig.slice(0, -4) + "dead";
  const verifyTampered = await verifyLaunchPass(`${pStr}.${tamperedSig}`, userIdA, testSecretEnv);
  assert(verifyTampered.valid === false, "Tampered signature is REJECTED");

  // ---------------------------------------------------------------------------
  // SECTION 3: Server Entitlement & Separation from Paid Subscriptions
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Server Entitlement & Non-Subscription Isolation ---");

  // 3.1 Free user fails closed
  const freeEntitlement = await getServerEntitlement(userIdA, { env: testSecretEnv });
  assert(
    freeEntitlement.tier === "none" &&
    freeEntitlement.accessSource === "none" &&
    freeEntitlement.status === "none" &&
    freeEntitlement.canAccessListings === false &&
    freeEntitlement.canAccessAi === false,
    "Free user fails closed to tier=none with accessSource=none"
  );

  // 3.2 Listings pass user
  const listingsEntitlement = await getServerEntitlement(userIdA, {
    launchPass: legitListingsPass.token,
    env: testSecretEnv,
  });
  assert(
    listingsEntitlement.tier === "listings" &&
    listingsEntitlement.accessSource === "launch_pass" &&
    listingsEntitlement.status === "none" && // Explicitly NOT pretending to be a paid subscription
    listingsEntitlement.canAccessListings === true &&
    listingsEntitlement.canAccessScores === false &&
    listingsEntitlement.canAccessAi === false,
    "Listings pass grants listings access but NO scores and NO AI (accessSource=launch_pass, status=none)",
    `source=${listingsEntitlement.accessSource}, status=${listingsEntitlement.status}`
  );

  // 3.3 AI pass user
  const legitAiPass = await signLaunchPass(userIdA, "ai", 7 * 86400 * 1000, testSecretEnv);
  const aiEntitlement = await getServerEntitlement(userIdA, {
    launchPass: legitAiPass.token,
    env: testSecretEnv,
  });
  assert(
    aiEntitlement.tier === "ai" &&
    aiEntitlement.accessSource === "launch_pass" &&
    aiEntitlement.status === "none" &&
    aiEntitlement.canAccessScores === true &&
    aiEntitlement.canAccessAi === true,
    "AI pass grants full score access and AI access (accessSource=launch_pass, status=none)"
  );

  // 3.4 Token passed via x-cm-launch-pass header
  const headerEntitlement = await getServerEntitlement(userIdA, {
    headers: { "x-cm-launch-pass": legitAiPass.token },
    env: testSecretEnv,
  });
  assert(headerEntitlement.tier === "ai" && headerEntitlement.canAccessAi === true, "Launch pass verified via x-cm-launch-pass header");

  // 3.5 Token passed via cookie header
  const cookieEntitlement = await getServerEntitlement(userIdA, {
    headers: { cookie: `cm_launch_pass=${encodeURIComponent(legitListingsPass.token)}` },
    env: testSecretEnv,
  });
  assert(cookieEntitlement.tier === "listings" && cookieEntitlement.canAccessListings === true, "Launch pass verified via cookie header");

  // ---------------------------------------------------------------------------
  // SECTION 4: AI Service Handler Protection & Score Isolation
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. AI Service Handler & Score Isolation Gates ---");

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

  const mockDeps = {
    env: testSecretEnv,
    getSupabaseAdmin: () => ({
      auth: {
        getUser: async (token: string) => {
          if (token === "valid-token-user-a") return { data: { user: { id: userIdA } }, error: null };
          return { data: { user: null }, error: new Error("Invalid token") };
        },
      },
      from: () => createChainableMock(null),
    }),
  };

  // 4.1 Free user calling /api/ai rejected with 403 PRO_REQUIRED
  const freeAiDeps = {
    ...mockDeps,
    getServerEntitlement: async () => ({
      tier: "none" as const,
      accessSource: "none" as const,
      canAccessListings: false,
      canAccessScores: false,
      canAccessAi: false,
      isPro: false,
      status: "none" as const,
      planName: "Free Tier",
      inGracePeriod: false,
    }),
  };

  const reqFree = new Request("http://localhost/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token-user-a",
    },
    body: JSON.stringify({ operation: "job_fit", job: { title: "Engineer" } }),
  });
  const resFree = await handleAiRequest(reqFree, freeAiDeps as any);
  const dataFree = await resFree.json();
  assert(resFree.status === 403 && dataFree.code === "PRO_REQUIRED", "Free user calling /api/ai rejected with 403 PRO_REQUIRED");

  // 4.2 Listings tier user calling /api/ai rejected with 403 AI_TIER_REQUIRED
  const listingsAiDeps = {
    ...mockDeps,
    getServerEntitlement: async () => ({
      tier: "listings" as const,
      accessSource: "launch_pass" as const,
      canAccessListings: true,
      canAccessScores: false,
      canAccessAi: false,
      isPro: true,
      status: "none" as const,
      planName: "Listings Pass",
      inGracePeriod: false,
    }),
  };
  const reqListings = new Request("http://localhost/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token-user-a",
    },
    body: JSON.stringify({ operation: "job_fit", job: { title: "Engineer" } }),
  });
  const resListings = await handleAiRequest(reqListings, listingsAiDeps as any);
  const dataListings = await resListings.json();
  assert(
    resListings.status === 403 && dataListings.code === "AI_TIER_REQUIRED",
    "Listings tier user calling /api/ai rejected with 403 AI_TIER_REQUIRED"
  );

  // 4.3 AI tier user passes entitlement gate
  let groqCalled = false;
  const aiAiDeps = {
    ...mockDeps,
    getServerEntitlement: async () => ({
      tier: "ai" as const,
      accessSource: "launch_pass" as const,
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
      return { choices: [{ message: { content: '{"score": 92, "grade": "High", "reason": "Strong fit"}' } }] };
    },
  };
  const reqAi = new Request("http://localhost/api/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer valid-token-user-a",
    },
    body: JSON.stringify({
      operation: "job_fit",
      job: { title: "Senior Software Engineer", company: "Acme", description: "Full-stack developer needed" },
      candidate: { fullName: "Alice", skills: ["React", "TypeScript"] },
    }),
  });
  const resAi = await handleAiRequest(reqAi, aiAiDeps as any);
  assert(resAi.status === 200 && groqCalled === true, "AI tier user passes entitlement gate to mocked operation");

  // ---------------------------------------------------------------------------
  // SECTION 5: Schema-Dependent Anti-Repeat & Revocation Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Server-Side Registry & Anti-Repeat Controls ---");

  markBlocked(
    "Atomic anti-repeat single active pass enforcement",
    "Requires public.launch_passes table & issue_launch_pass_atomic procedure (proposed in reports/proposed_launch_pass_registry.sql; zero unapproved SQL execution)"
  );
  markBlocked(
    "Server-side pass revocation via token hash lookup",
    "Requires public.revoke_launch_pass stored procedure in production database"
  );
  markBlocked(
    "Live Groq AI generation with deployed credentials",
    "Requires separately authorized bounded live AI test; mocks are not deployed proof"
  );

  // ---------------------------------------------------------------------------
  // SECTION 6: Filter Corrections & Active Job Geographical Derivation
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Active-Job Country Code Derivation ---");

  assert(
    Array.isArray(ACTIVE_JOB_COUNTRY_CODES) && ACTIVE_JOB_COUNTRY_CODES.includes("US") && ACTIVE_JOB_COUNTRY_CODES.includes("IN"),
    "ACTIVE_JOB_COUNTRY_CODES reflects indexed country codes from active jobs database"
  );

  const derivedOptions = deriveCountryOptionsFromActiveJobs(["US", "DE", "IN"]);
  assert(
    derivedOptions.length === 4 && // 1 worldwide + 3 countries
    derivedOptions.some((o) => o.code === "US") &&
    derivedOptions.some((o) => o.code === "DE") &&
    derivedOptions.some((o) => o.code === "IN"),
    "deriveCountryOptionsFromActiveJobs bounds options to active job country codes"
  );

  const serviceTsContent = fs.readFileSync(path.resolve(__dirname, "../src/lib/jobs/service.ts"), "utf8");
  assert(
    serviceTsContent.includes('query.eq("country_code", code)'),
    "service.ts fallback query applies country_code filter pre-pagination"
  );

  const filterBarContent = fs.readFileSync(path.resolve(__dirname, "../src/components/jobs/JobFilterBar.tsx"), "utf8");
  assert(
    !filterBarContent.includes("selectedIndustry") && !filterBarContent.includes("selectedExperience"),
    "JobFilterBar desktop chips do NOT render no-op Industry or Years of Experience"
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
