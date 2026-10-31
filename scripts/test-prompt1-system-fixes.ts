import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import { verifyAdminSession } from "../src/lib/admin/auth";
import {
  isVerifiedAdminUser,
  isEmailInAdminList,
  isUserEmailVerified,
  hasAdminGoogleProvider,
} from "../src/lib/admin/constants";
import { GET as getAdminStats } from "../src/app/api/admin/stats/route";
import { middleware } from "../src/middleware";
import {
  handleAccountDeleteRequest,
  ACCOUNT_DELETE_USER_ID_TABLES,
  ACCOUNT_DELETE_EMAIL_TABLES,
  RECONCILABLE_SUBSCRIPTION_STATUSES,
  listBucketFilesRecursively,
} from "../src/lib/account/deleteHandler";
import {
  RESUME_STORAGE_BUCKET,
  RESUME_BUCKET_CONFIG,
  isOwnerScopedResumePath,
  uploadResumeFile,
  getResumeSignedUrl,
} from "../src/lib/resume/storage";
import { handleInterviewPackRequest } from "../src/lib/interview-pack/handler";
import { handleSkillWhatIfRequest } from "../src/lib/skill-what-if/handler";
import { SAMPLE_INTERVIEW_PACK } from "../src/data/interviewPackFixture";
import { SAMPLE_SKILL_WHAT_IF } from "../src/data/skillWhatIfFixture";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("      PROMPT 1 SYSTEM FIXES VERIFICATION SUITE (ADMIN, DELETE, RESUMES, AI)       ");
  console.log("==================================================================================");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL] Asserting intentional failure condition...");
    assert.strictEqual(
      isUserEmailVerified({
        email: "xbsuryakant@gmail.com",
        email_confirmed_at: null,
        user_metadata: { email_verified: true },
      }),
      true,
      "NEGATIVE CONTROL: user_metadata.email_verified must NOT satisfy isUserEmailVerified!"
    );
    process.exit(0);
  }

  const originalFetch = global.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock_anon_key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock_service_role_key";

  try {
    // =========================================================================
    // (a) Admin routes and APIs:
    //     email in admin list AND email_confirmed_at/confirmed_at set
    //     AND app_metadata provider/providers includes google (no user_metadata)
    // =========================================================================
    console.log("\n--- (a) Testing Admin Routes & APIs Server-Side Verification ---");

    const constantsSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/admin/constants.ts"),
      "utf-8"
    );
    assert.ok(
      !constantsSrc.includes("user_metadata.email_verified") &&
        !constantsSrc.includes("user_metadata?.email_verified"),
      "src/lib/admin/constants.ts must not check user_metadata.email_verified"
    );

    assert.strictEqual(isEmailInAdminList("xbsuryakant@gmail.com"), true);
    assert.strictEqual(isEmailInAdminList("intruder@example.com"), false);
    assert.strictEqual(isUserEmailVerified({ email_confirmed_at: null }), false);
    assert.strictEqual(
      isUserEmailVerified({
        email_confirmed_at: null,
        confirmed_at: null,
        user_metadata: { email_verified: true },
      }),
      false,
      "user_metadata.email_verified must be ignored when email_confirmed_at/confirmed_at are absent"
    );
    assert.strictEqual(isUserEmailVerified({ email_confirmed_at: "2026-10-31T00:00:00.000Z" }), true);
    assert.strictEqual(isUserEmailVerified({ confirmed_at: "2026-10-31T00:00:00.000Z" }), true);

    assert.strictEqual(
      hasAdminGoogleProvider({ app_metadata: { provider: "email", providers: ["email"] } }),
      false
    );
    assert.strictEqual(
      hasAdminGoogleProvider({ app_metadata: { provider: "google", providers: ["google"] } }),
      true
    );

    // Admin email without email_confirmed_at -> rejected
    assert.strictEqual(
      isVerifiedAdminUser({
        email: "xbsuryakant@gmail.com",
        email_confirmed_at: null,
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: { email_verified: true },
      }),
      false,
      "Admin email without email_confirmed_at/confirmed_at must be rejected even if user_metadata.email_verified is true"
    );

    // Admin email with email_confirmed_at but email-only provider (no google) -> rejected
    assert.strictEqual(
      isVerifiedAdminUser({
        email: "xbsuryakant@gmail.com",
        email_confirmed_at: "2026-10-31T00:00:00.000Z",
        app_metadata: { provider: "email", providers: ["email"] },
      }),
      false,
      "Admin email with email-only provider (no google) must be rejected"
    );

    // Admin email with email_confirmed_at AND google provider -> accepted
    assert.strictEqual(
      isVerifiedAdminUser({
        email: "xbsuryakant@gmail.com",
        email_confirmed_at: "2026-10-31T00:00:00.000Z",
        app_metadata: { provider: "google", providers: ["google"] },
      }),
      true,
      "Admin email with email_confirmed_at AND google provider must be accepted"
    );

    // 1. Admin API with unverified admin email -> 403
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "admin-unverified",
            email: "xbsuryakant@gmail.com",
            email_confirmed_at: null,
            app_metadata: { provider: "google", providers: ["google"] },
            user_metadata: { email_verified: true },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const unverifiedAdminReq = new Request("http://localhost:3000/api/admin/stats", {
      headers: { Authorization: "Bearer token_unverified_admin" },
    });
    const unverifiedCheck = await verifyAdminSession(unverifiedAdminReq);
    assert.strictEqual(unverifiedCheck.isAdmin, false, "Unverified admin email must fail verifyAdminSession");
    const unverifiedStatsRes = await getAdminStats(unverifiedAdminReq);
    assert.strictEqual(unverifiedStatsRes.status, 403, "Unverified admin email must receive HTTP 403");

    // 1b. Admin API with email-only provider -> 403
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "admin-email-only",
            email: "xbsuryakant@gmail.com",
            email_confirmed_at: "2026-10-31T00:00:00.000Z",
            app_metadata: { provider: "email", providers: ["email"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };
    const emailOnlyAdminRes = await getAdminStats(
      new Request("http://localhost:3000/api/admin/stats", {
        headers: { Authorization: "Bearer token_email_only_admin" },
      })
    );
    assert.strictEqual(emailOnlyAdminRes.status, 403, "Email-only admin without Google provider must receive HTTP 403");

    // 2. Middleware check on /admin and /api/admin/stats:
    const guestAdminPageRes = await middleware(new NextRequest("http://localhost:3000/admin"));
    assert.strictEqual(guestAdminPageRes.status, 403, "Guest request to /admin must return 403");
    const guestAdminApiRes = await middleware(new NextRequest("http://localhost:3000/api/admin/stats"));
    assert.strictEqual(guestAdminApiRes.status, 403, "Guest request to /api/admin/stats must return 403");

    // Verified Google admin requesting /admin -> 200
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "admin-verified",
            email: "xbsuryakant@gmail.com",
            email_confirmed_at: "2026-10-31T00:00:00.000Z",
            app_metadata: { provider: "google", providers: ["google"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/rest/v1/early_access_approved")) {
        return new Response(JSON.stringify([{ email: "xbsuryakant@gmail.com", approved: true }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };
    const verifiedAdminPageRes = await middleware(
      new NextRequest("http://localhost:3000/admin", {
        headers: { Authorization: "Bearer verified_admin_token" },
      })
    );
    assert.strictEqual(verifiedAdminPageRes.status, 200, "Verified Google admin requesting /admin must pass with 200");

    // Static check on src/app/admin/layout.tsx: no localStorage bypass
    const adminLayoutSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/app/admin/layout.tsx"),
      "utf-8"
    );
    assert.ok(
      !adminLayoutSrc.includes("localStorage.getItem"),
      "src/app/admin/layout.tsx must not use client-only localStorage admin checks"
    );
    assert.ok(
      adminLayoutSrc.includes("isVerifiedAdminUser"),
      "src/app/admin/layout.tsx must use isVerifiedAdminUser"
    );
    console.log("  [PASS] (a) Admin routes & APIs enforce admin list + email_confirmed_at/confirmed_at + Google provider (403 otherwise)");

    // =========================================================================
    // (b) Account delete:
    //     - Do NOT delete subscriptions rows; reconcile active, trialing, and
    //       in_grace_period subscriptions to canceled and keep the rows.
    //     - Migration changes subscriptions.user_id FK from ON DELETE CASCADE
    //       to ON DELETE SET NULL (nullable).
    //     - Recursively lists resume files with pagination (100 per page)
    //       before deleting auth user.
    // =========================================================================
    console.log("\n--- (b) & (c-cleanup) Testing Account Delete (Subscriptions Reconciled & Kept, Recursive Paginated Storage Cleanup) ---");

    assert.ok(
      !(ACCOUNT_DELETE_USER_ID_TABLES as readonly string[]).includes("subscriptions"),
      "ACCOUNT_DELETE_USER_ID_TABLES must NOT include subscriptions"
    );
    assert.deepStrictEqual(
      Array.from(RECONCILABLE_SUBSCRIPTION_STATUSES),
      ["active", "trialing", "in_grace_period"],
      "Must reconcile active, trialing, and in_grace_period subscription statuses"
    );

    // Verify all 3 statuses (active, trialing, in_grace_period) are reconciled to canceled and never deleted
    for (const subStatus of ["active", "trialing", "in_grace_period"] as const) {
      const operationsLog: string[] = [];
      const deletedTables = new Set<string>();
      const deletedEmailTables = new Set<string>();
      const updatedSubscriptions: Array<{ id: string; payload: any }> = [];
      const removedStorageBatches: string[][] = [];
      const listCalls: Array<{ prefix: string; limit?: number; offset?: number }> = [];

      // Build 125 top-level files (page 1 = 100 items including 1 subfolder "2026" + 99 files; page 2 = 26 files)
      const topPage0: any[] = [
        { name: "2026", id: null, metadata: null }, // subfolder entry
        ...Array.from({ length: 99 }, (_, i) => ({
          name: `resume_${String(i + 1).padStart(3, "0")}.pdf`,
          id: `file-${i + 1}`,
          metadata: { size: 1024 },
        })),
      ];
      const topPage1: any[] = Array.from({ length: 26 }, (_, i) => ({
        name: `resume_${String(i + 100).padStart(3, "0")}.pdf`,
        id: `file-${i + 100}`,
        metadata: { size: 1024 },
      }));

      const mockDeleteAdmin = {
        auth: {
          getUser: async () => ({
            data: {
              user: {
                id: "user-del-999",
                email: "candidate@example.com",
              },
            },
            error: null,
          }),
          admin: {
            deleteUser: async (uid: string) => {
              operationsLog.push(`auth.admin.deleteUser:${uid}`);
              return { error: null };
            },
          },
        },
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: { id: `sub-${subStatus}`, status: subStatus, metadata: { plan: "pro" } },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: (payload: any) => ({
            eq: async (_col: string, val: string) => {
              operationsLog.push(`update:${table}:${val}:${payload.status}`);
              if (table === "subscriptions") {
                updatedSubscriptions.push({ id: val, payload });
              }
              return { error: null };
            },
          }),
          delete: () => ({
            eq: async (col: string, val: string) => {
              operationsLog.push(`delete:${table}:${col}=${val}`);
              if (col === "user_id") deletedTables.add(table);
              if (col === "email") deletedEmailTables.add(table);
              return { error: null };
            },
          }),
        }),
        storage: {
          from: (bucket: string) => ({
            list: async (prefix: string, opts?: { limit?: number; offset?: number }) => {
              listCalls.push({ prefix, limit: opts?.limit, offset: opts?.offset });
              if (bucket !== "resumes") return { data: [], error: null };
              const offset = opts?.offset || 0;
              if (prefix === "user-del-999") {
                if (offset === 0) return { data: topPage0, error: null };
                if (offset === 100) return { data: topPage1, error: null };
                return { data: [], error: null };
              }
              if (prefix === "user-del-999/2026") {
                return {
                  data: [{ name: "oct", id: null, metadata: null }],
                  error: null,
                };
              }
              if (prefix === "user-del-999/2026/oct") {
                return {
                  data: [{ name: "nested_cv.pdf", id: "file-nested-1", metadata: { size: 2048 } }],
                  error: null,
                };
              }
              return { data: [], error: null };
            },
            remove: async (paths: string[]) => {
              operationsLog.push(`storage.remove:${bucket}:${paths.length}`);
              removedStorageBatches.push(paths);
              return { error: null };
            },
          }),
          listBuckets: async () => ({
            data: [{ name: "resumes" }],
            error: null,
          }),
        },
      };

      const delReq = new Request("http://localhost:3000/api/account/delete", {
        method: "POST",
        headers: { Authorization: "Bearer valid_delete_token" },
      });
      const delRes = await handleAccountDeleteRequest(delReq, {
        getSupabaseAdmin: () => mockDeleteAdmin,
      });
      assert.strictEqual(delRes.status, 200, `Account deletion should return 200 OK for subscription status ${subStatus}`);
      const delBody = await delRes.json();
      assert.strictEqual(delBody.billingReconciled, true, `Subscription with status '${subStatus}' must be reconciled`);

      // Verify subscriptions was updated to canceled and NEVER deleted
      assert.strictEqual(updatedSubscriptions.length, 1);
      assert.strictEqual(updatedSubscriptions[0].id, `sub-${subStatus}`);
      assert.strictEqual(updatedSubscriptions[0].payload.status, "canceled");
      assert.strictEqual(updatedSubscriptions[0].payload.cancel_at_period_end, true);
      assert.strictEqual(
        deletedTables.has("subscriptions"),
        false,
        "subscriptions rows must NEVER be deleted during account deletion"
      );

      // Verify user-owned tables + early_access_emails were deleted
      for (const requiredTable of [
        "candidate_profiles",
        "user_preferences",
        "resumes",
        "tailored_resumes",
        "saved_jobs",
        "applications",
        "job_applications",
      ]) {
        assert.ok(
          deletedTables.has(requiredTable),
          `Account delete must delete rows from ${requiredTable}`
        );
      }
      assert.ok(
        deletedEmailTables.has("early_access_emails"),
        "Account delete must delete early_access link in early_access_emails"
      );

      // Verify recursive + paginated storage listing (99 + 26 + 1 nested = 126 files total)
      const allRemovedFiles = removedStorageBatches.reduce((acc, b) => acc.concat(b), [] as string[]);
      assert.strictEqual(
        allRemovedFiles.length,
        126,
        `Expected all 126 files across 2 pages + nested folders to be removed, got ${allRemovedFiles.length}`
      );
      assert.ok(
        allRemovedFiles.includes("user-del-999/resume_001.pdf") &&
          allRemovedFiles.includes("user-del-999/resume_125.pdf") &&
          allRemovedFiles.includes("user-del-999/2026/oct/nested_cv.pdf"),
        "Must remove page 1 files, page 2 files (offset 100), and recursively nested files"
      );
      assert.ok(
        listCalls.some((c) => c.prefix === "user-del-999" && c.limit === 100 && c.offset === 0) &&
          listCalls.some((c) => c.prefix === "user-del-999" && c.limit === 100 && c.offset === 100) &&
          listCalls.some((c) => c.prefix === "user-del-999/2026" && c.limit === 100 && c.offset === 0) &&
          listCalls.some((c) => c.prefix === "user-del-999/2026/oct" && c.limit === 100 && c.offset === 0),
        "Must paginate with limit=100, offset=0/100 and recurse into nested folders"
      );

      // Verify auth.admin.deleteUser is executed LAST
      assert.strictEqual(
        operationsLog[operationsLog.length - 1],
        "auth.admin.deleteUser:user-del-999",
        "auth.admin.deleteUser must be executed LAST after all rows and recursive storage files are deleted"
      );
    }

    // Verify migration SQL for subscriptions FK ON DELETE SET NULL (nullable)
    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/20261031_account_delete_and_private_resumes.sql"),
      "utf-8"
    );
    assert.ok(
      migrationSql.includes("ALTER TABLE public.subscriptions") &&
        migrationSql.includes("ALTER COLUMN user_id DROP NOT NULL") &&
        migrationSql.includes("DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey") &&
        migrationSql.includes("REFERENCES auth.users(id)") &&
        migrationSql.includes("ON DELETE SET NULL"),
      "Migration must make subscriptions.user_id nullable and change FK to ON DELETE SET NULL"
    );
    assert.ok(
      !migrationSql.includes("DELETE FROM public.subscriptions"),
      "Migration reference steps must not delete from public.subscriptions"
    );
    assert.ok(migrationSql.includes("DELETE FROM public.candidate_profiles WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.resumes            WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.saved_jobs         WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.applications       WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.early_access_emails WHERE lower(email) = lower(:email);"));
    assert.ok(migrationSql.includes("auth.admin.deleteUser(:uid)"));
    console.log("  [PASS] (b) Account delete reconciles active/trialing/in_grace_period subscriptions to canceled & keeps rows, recursively/paginates resume storage cleanup, and deletes auth user last");

    // =========================================================================
    // (c) Resume files: private bucket, owner-only access via signed URLs, no public URLs
    // =========================================================================
    console.log("\n--- (c) Testing Private Resume Bucket & Owner-Only Signed URLs ---");

    assert.strictEqual(RESUME_STORAGE_BUCKET, "resumes");
    assert.strictEqual(RESUME_BUCKET_CONFIG.public, false, "Resume bucket must be private (public: false)");
    assert.strictEqual(isOwnerScopedResumePath("user-123/cv.pdf", "user-123"), true);
    assert.strictEqual(isOwnerScopedResumePath("user-999/cv.pdf", "user-123"), false);
    assert.strictEqual(isOwnerScopedResumePath("user-123/../user-999/cv.pdf", "user-123"), false);

    let uploadedObjectPath = "";
    const mockResumeClient = {
      auth: {
        getUser: async () => ({
          data: { user: { id: "owner-user-123" } },
          error: null,
        }),
      },
      storage: {
        from: (bucket: string) => {
          assert.strictEqual(bucket, "resumes");
          return {
            upload: async (objectPath: string) => {
              uploadedObjectPath = objectPath;
              return { data: { path: objectPath }, error: null };
            },
            createSignedUrl: async (objectPath: string, expiresIn: number) => ({
              data: {
                signedUrl: `https://mock.supabase.co/storage/v1/object/sign/resumes/${objectPath}?token=signed_${expiresIn}`,
              },
              error: null,
            }),
          };
        },
      },
    };

    const uploadResult = await uploadResumeFile(
      new Uint8Array([1, 2, 3]),
      "My Resume.pdf",
      mockResumeClient
    );
    assert.ok(uploadResult.path.startsWith("owner-user-123/"), "Uploaded resume path must be scoped to owner ID");
    assert.ok(
      uploadResult.signedUrl.includes("/storage/v1/object/sign/resumes/owner-user-123/"),
      "Upload must return a signed URL, never a public URL"
    );

    const ownerSignedUrl = await getResumeSignedUrl(uploadedObjectPath, 300, mockResumeClient);
    assert.ok(ownerSignedUrl.includes("token=signed_300"));

    let crossUserBlocked = false;
    try {
      await getResumeSignedUrl("another-user-456/resume.pdf", 300, mockResumeClient);
    } catch (err: any) {
      crossUserBlocked = err.message.includes("Forbidden");
    }
    assert.strictEqual(crossUserBlocked, true, "Cross-user resume signed URL request must be blocked");

    const resumeStorageSrc = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/resume/storage.ts"),
      "utf-8"
    );
    assert.ok(!resumeStorageSrc.includes("getPublicUrl"), "src/lib/resume/storage.ts must never use getPublicUrl");
    assert.ok(resumeStorageSrc.includes("createSignedUrl"), "src/lib/resume/storage.ts must use createSignedUrl");
    assert.ok(
      migrationSql.includes("INSERT INTO storage.buckets") &&
        migrationSql.includes("'resumes'") &&
        migrationSql.includes("FALSE") &&
        migrationSql.includes("(storage.foldername(name))[1] = auth.uid()::text"),
      "Migration must enforce private resumes bucket (public = FALSE) and owner-only folder RLS policies"
    );
    console.log("  [PASS] (c) Resume files use private bucket + owner-only signed URLs, zero public URLs");

    // =========================================================================
    // (d) Interview Pack & What-If return 503 not_available_yet until a real generator exists
    // =========================================================================
    console.log("\n--- (d) Testing Interview Pack & What-If 503 not_available_yet Until Real Generator Exists ---");

    const mockProAdmin = () => ({
      auth: {
        getUser: async () => ({
          data: { user: { id: "pro-user-1", user_metadata: {} } },
          error: null,
        }),
      },
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    });

    const ipNoAiRes = await handleInterviewPackRequest(
      new Request("http://localhost:3000/api/jobs/interview-pack?jobId=job_123", {
        headers: { Authorization: "Bearer pro_token" },
      }),
      {
        getSupabaseAdmin: mockProAdmin,
        getServerEntitlement: async () => ({ isPro: true }),
      }
    );
    assert.strictEqual(ipNoAiRes.status, 503);
    const ipNoAiBody = await ipNoAiRes.json();
    assert.strictEqual(ipNoAiBody.pack, null);
    assert.strictEqual(ipNoAiBody.available, false);
    assert.strictEqual(ipNoAiBody.status, "not_available_yet");
    assert.ok(ipNoAiBody.message.toLowerCase().includes("not available yet"));

    const ipSampleLeakRes = await handleInterviewPackRequest(
      new Request("http://localhost:3000/api/jobs/interview-pack?jobId=job_123", {
        headers: { Authorization: "Bearer pro_token" },
      }),
      {
        getSupabaseAdmin: mockProAdmin,
        getServerEntitlement: async () => ({ isPro: true }),
        generateInterviewPack: async () => SAMPLE_INTERVIEW_PACK,
      }
    );
    assert.strictEqual(ipSampleLeakRes.status, 503, "Must reject sample fixture pack even if returned by generator");

    const swiNoAiRes = await handleSkillWhatIfRequest(
      new Request("http://localhost:3000/api/jobs/skill-what-if?jobId=job_123", {
        headers: { Authorization: "Bearer pro_token" },
      }),
      {
        getSupabaseAdmin: mockProAdmin,
        getServerEntitlement: async () => ({ isPro: true }),
      }
    );
    assert.strictEqual(swiNoAiRes.status, 503);
    const swiNoAiBody = await swiNoAiRes.json();
    assert.strictEqual(swiNoAiBody.simulation, null);
    assert.strictEqual(swiNoAiBody.available, false);
    assert.strictEqual(swiNoAiBody.status, "not_available_yet");
    assert.ok(swiNoAiBody.message.toLowerCase().includes("not available yet"));

    const swiSampleLeakRes = await handleSkillWhatIfRequest(
      new Request("http://localhost:3000/api/jobs/skill-what-if?jobId=job_123", {
        headers: { Authorization: "Bearer pro_token" },
      }),
      {
        getSupabaseAdmin: mockProAdmin,
        getServerEntitlement: async () => ({ isPro: true }),
        generateSkillWhatIf: async () => SAMPLE_SKILL_WHAT_IF,
      }
    );
    assert.strictEqual(swiSampleLeakRes.status, 503, "Must reject sample fixture simulation even if returned by generator");

    console.log("  [PASS] (d) Interview Pack & Skill What-If return 503 not_available_yet until a real generator exists");

    // =========================================================================
    // Subprocess Negative Control Check
    // =========================================================================
    console.log("\n--- Verifying Subprocess Negative Control ---");
    const neg = spawnSync(process.execPath, ["--import", "tsx", __filename, "--negative-control"], {
      encoding: "utf-8",
      env: process.env,
    });
    assert.notStrictEqual(neg.status, 0, "Negative control subprocess must exit with non-zero status");
    console.log(`  [PASS] Negative control exited with non-zero code (${neg.status})`);

    console.log("\n==================================================================================");
    console.log("PROMPT 1 SYSTEM FIXES: ALL TESTS PASSED [PASS-LOCAL]");
    console.log("==================================================================================");
  } finally {
    global.fetch = originalFetch;
  }
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
