import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { NextRequest } from "next/server";
import { verifyAdminSession } from "../src/lib/admin/auth";
import { isVerifiedAdminUser, isEmailInAdminList, isUserEmailVerified } from "../src/lib/admin/constants";
import { GET as getAdminStats } from "../src/app/api/admin/stats/route";
import { middleware } from "../src/middleware";
import {
  handleAccountDeleteRequest,
  ACCOUNT_DELETE_USER_ID_TABLES,
  ACCOUNT_DELETE_EMAIL_TABLES,
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
      isVerifiedAdminUser({
        email: "xbsuryakant@gmail.com",
        email_confirmed_at: null,
      }),
      true,
      "NEGATIVE CONTROL: Unverified admin email must NOT be treated as verified admin!"
    );
    process.exit(0);
  }

  const originalFetch = global.fetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock_anon_key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock_service_role_key";

  try {
    // =========================================================================
    // (a) Admin routes and APIs: server-side check (in admin list AND verified)
    // =========================================================================
    console.log("\n--- (a) Testing Admin Routes & APIs Server-Side Verification ---");

    assert.strictEqual(isEmailInAdminList("xbsuryakant@gmail.com"), true);
    assert.strictEqual(isEmailInAdminList("intruder@example.com"), false);
    assert.strictEqual(isUserEmailVerified({ email_confirmed_at: null }), false);
    assert.strictEqual(isUserEmailVerified({ email_confirmed_at: "2026-10-31T00:00:00.000Z" }), true);
    assert.strictEqual(
      isVerifiedAdminUser({ email: "xbsuryakant@gmail.com", email_confirmed_at: null }),
      false,
      "Admin email without email verification must be rejected"
    );
    assert.strictEqual(
      isVerifiedAdminUser({ email: "xbsuryakant@gmail.com", email_confirmed_at: "2026-10-31T00:00:00.000Z" }),
      true,
      "Admin email with email verification must be accepted"
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

    // 2. Middleware check on /admin and /api/admin/stats:
    // Guest -> 403
    const guestAdminPageRes = await middleware(new NextRequest("http://localhost:3000/admin"));
    assert.strictEqual(guestAdminPageRes.status, 403, "Guest request to /admin must return 403");
    const guestAdminApiRes = await middleware(new NextRequest("http://localhost:3000/api/admin/stats"));
    assert.strictEqual(guestAdminApiRes.status, 403, "Guest request to /api/admin/stats must return 403");

    // Non-admin with valid session -> 403 on /admin
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "user-non-admin",
            email: "member@example.com",
            email_confirmed_at: "2026-10-31T00:00:00.000Z",
            app_metadata: { provider: "google", providers: ["google"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/rest/v1/early_access_approved")) {
        return new Response(JSON.stringify([{ email: "member@example.com", approved: true }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const nonAdminPageReq = new NextRequest("http://localhost:3000/admin", {
      headers: { Authorization: "Bearer valid_member_token" },
    });
    const nonAdminPageRes = await middleware(nonAdminPageReq);
    assert.strictEqual(nonAdminPageRes.status, 403, "Non-admin user requesting /admin must receive 403");

    // Unverified admin requesting /admin -> 403
    global.fetch = async (input: any): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({
            id: "admin-unverified",
            email: "xbsuryakant@gmail.com",
            email_confirmed_at: null,
            app_metadata: { provider: "google", providers: ["google"] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("Not found", { status: 404 });
    };
    const unverifiedAdminPageRes = await middleware(
      new NextRequest("http://localhost:3000/admin", {
        headers: { Authorization: "Bearer unverified_admin_token" },
      })
    );
    assert.strictEqual(unverifiedAdminPageRes.status, 403, "Unverified admin requesting /admin must receive 403");

    // Verified admin requesting /admin -> 200
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
    assert.strictEqual(verifiedAdminPageRes.status, 200, "Verified admin requesting /admin must pass with 200");

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
    console.log("  [PASS] (a) Admin routes & APIs enforce server-side admin list + verified email (403 otherwise)");

    // =========================================================================
    // (b) Account delete: profile, resumes, saved jobs, applications,
    //     subscriptions, early_access link, stored resume files, then auth user
    // =========================================================================
    console.log("\n--- (b) Testing Account Delete Full Row + Storage + Auth Cleanup Order ---");

    const operationsLog: string[] = [];
    const deletedTables = new Set<string>();
    const deletedEmailTables = new Set<string>();
    const removedStoragePaths: string[] = [];

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
                  data: { id: "sub-999", status: "active", metadata: {} },
                  error: null,
                }),
              }),
            }),
          }),
        }),
        update: () => ({
          eq: async () => {
            operationsLog.push(`update:${table}`);
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
          list: async (prefix: string) => ({
            data: bucket === "resumes" && prefix === "user-del-999" ? [{ name: "my_cv.pdf" }] : [],
            error: null,
          }),
          remove: async (paths: string[]) => {
            operationsLog.push(`storage.remove:${bucket}:${paths.join(",")}`);
            removedStoragePaths.push(...paths);
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
    assert.strictEqual(delRes.status, 200, "Account deletion should return 200 OK");

    for (const requiredTable of [
      "candidate_profiles",
      "resumes",
      "tailored_resumes",
      "saved_jobs",
      "applications",
      "job_applications",
      "subscriptions",
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
    assert.ok(
      removedStoragePaths.includes("user-del-999/my_cv.pdf"),
      "Account delete must remove stored resume files under ${userId}/"
    );
    assert.strictEqual(
      operationsLog[operationsLog.length - 1],
      "auth.admin.deleteUser:user-del-999",
      "auth.admin.deleteUser must be executed LAST after all rows and storage files are deleted"
    );
    assert.ok(ACCOUNT_DELETE_USER_ID_TABLES.includes("resumes"));
    assert.ok(ACCOUNT_DELETE_USER_ID_TABLES.includes("saved_jobs"));
    assert.ok(ACCOUNT_DELETE_EMAIL_TABLES.includes("early_access_emails"));

    const migrationSql = fs.readFileSync(
      path.resolve(process.cwd(), "supabase/migrations/20261031_account_delete_and_private_resumes.sql"),
      "utf-8"
    );
    assert.ok(migrationSql.includes("DELETE FROM public.candidate_profiles WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.resumes            WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.saved_jobs         WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.applications       WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.subscriptions      WHERE user_id = :uid;"));
    assert.ok(migrationSql.includes("DELETE FROM public.early_access_emails   WHERE lower(email) = lower(:email);"));
    assert.ok(migrationSql.includes("auth.admin.deleteUser(:uid)"));
    console.log("  [PASS] (b) Account delete removes profile, resumes, saved_jobs, applications, subscriptions, early_access link, stored resume files, then auth user last");

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

    // Owner access succeeds
    const ownerSignedUrl = await getResumeSignedUrl(uploadedObjectPath, 300, mockResumeClient);
    assert.ok(ownerSignedUrl.includes("token=signed_300"));

    // Non-owner access is rejected
    let crossUserBlocked = false;
    try {
      await getResumeSignedUrl("another-user-456/resume.pdf", 300, mockResumeClient);
    } catch (err: any) {
      crossUserBlocked = err.message.includes("Forbidden");
    }
    assert.strictEqual(crossUserBlocked, true, "Cross-user resume signed URL request must be blocked");

    // Static check: no getPublicUrl in src/lib/resume/storage.ts and private bucket SQL in migration
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
    // (d) Interview Pack & What-If never return sample data as if real
    // =========================================================================
    console.log("\n--- (d) Testing Interview Pack & What-If Real AI vs Not-Available-Yet ---");

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

    // 1. Interview Pack without real AI result -> 503 not_available_yet
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

    // 2. Interview Pack when generator tries to return SAMPLE_INTERVIEW_PACK -> rejected as 503 not_available_yet
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

    // 3. Skill What-If without real AI result -> 503 not_available_yet
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

    // 4. Skill What-If when generator tries to return SAMPLE_SKILL_WHAT_IF -> rejected as 503 not_available_yet
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

    console.log("  [PASS] (d) Interview Pack & Skill What-If never return sample data as if real (return real AI or 503 not_available_yet)");

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
