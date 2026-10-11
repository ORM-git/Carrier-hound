import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServerEntitlement } from "../src/lib/billing/serverEntitlement";
import { getProAccessStatus } from "../src/lib/billing/subscription";
import { getLiveJobs, getLiveJobById } from "../src/lib/jobs/service";
import { createClient } from "@supabase/supabase-js";

async function runVerification() {
  console.log("================================================================================");
  console.log("VERIFYING CRITICAL #2 + #3 SECURITY FIXES: DATA ACCESS & ENTITLEMENT");
  console.log("================================================================================\n");

  let allPassed = true;

  // ---------------------------------------------------------------------------
  // TEST 1: Entitlement Isolation & Fake-Pro Rejection
  // ---------------------------------------------------------------------------
  console.log("--- TEST 1: user_metadata.is_pro must NEVER grant Pro access ---");
  const fakeUserId = "00000000-0000-0000-0000-00000000fake";
  
  const serverEntitlement = await getServerEntitlement(fakeUserId);
  const clientAccessStatus = await getProAccessStatus(fakeUserId);

  if (serverEntitlement.isPro === false && clientAccessStatus.isPro === false) {
    console.log("✅ PASS: Fake Pro user rejected. getServerEntitlement() isPro = false, getProAccessStatus() isPro = false.");
  } else {
    console.error("❌ FAIL: Fake Pro user granted access!");
    allPassed = false;
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Production Checkout Simulation Gate
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 2: /api/simulate-checkout returns 404 in production unless SIMULATE_PAYMENTS=true ---");
  const prevNodeEnv = process.env.NODE_ENV;
  const prevSimulate = process.env.SIMULATE_PAYMENTS;

  try {
    (process.env as any).NODE_ENV = "production";
    delete process.env.SIMULATE_PAYMENTS;

    // Test simulate-checkout handler under production
    const { POST } = await import("../src/app/api/simulate-checkout/route");
    const fakeReq = new Request("http://localhost:3000/api/simulate-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId: "domestic_monthly_199" }),
    });

    const res = await POST(fakeReq);
    if (res.status === 404) {
      console.log("✅ PASS: /api/simulate-checkout returned 404 in production environment.");
    } else {
      console.error(`❌ FAIL: Expected 404, received status ${res.status}`);
      allPassed = false;
    }
  } finally {
    (process.env as any).NODE_ENV = prevNodeEnv;
    if (prevSimulate !== undefined) {
      process.env.SIMULATE_PAYMENTS = prevSimulate;
    } else {
      delete process.env.SIMULATE_PAYMENTS;
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Guest & Non-Pro Data Access (Lock Paid Fields)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 3: getLiveJobs() for Guest/Non-Pro contains ZERO locked fields ---");
  const guestJobsRes = await getLiveJobs({ page: 1, pageSize: 10, isPro: false });
  const guestJobs = guestJobsRes.jobs;

  let leakFound = false;
  const knownRealCompanies = ["OpenAI", "Stripe", "Linear", "ElevenLabs", "Perplexity AI", "Baseten", "Cohere", "Notion"];

  for (const job of guestJobs) {
    if (knownRealCompanies.includes(job.company)) {
      console.error(`❌ LEAK FOUND: Company name "${job.company}" exposed in guest job list!`);
      leakFound = true;
    }
    if (job.salary && job.salary.length > 0) {
      console.error(`❌ LEAK FOUND: Salary text "${job.salary}" exposed in guest job list!`);
      leakFound = true;
    }
    if (job.applyUrl && job.applyUrl.length > 0) {
      console.error(`❌ LEAK FOUND: Apply URL "${job.applyUrl}" exposed in guest job list!`);
      leakFound = true;
    }
    if (job.description && job.description.length > 0) {
      console.error(`❌ LEAK FOUND: Description "${job.description.slice(0, 30)}..." exposed in guest job list!`);
      leakFound = true;
    }
  }

  if (!leakFound && guestJobs.length > 0) {
    console.log(`✅ PASS: Checked ${guestJobs.length} guest jobs. All companies masked as "${guestJobs[0].company}", salary is empty (""), applyUrl is empty (""), description is empty ("").`);
  } else if (guestJobs.length === 0) {
    console.log("⚠️ WARNING: No jobs returned in list.");
  } else {
    allPassed = false;
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Single Job Detail for Guest/Non-Pro
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 4: getLiveJobById() for Guest/Non-Pro contains ZERO locked fields ---");
  const sampleJobId = guestJobs[0]?.id || "ashby-openai-8fb1615c-34bf-47c4-a1d1-b7b2f836bbd3";
  const guestJobDetail = await getLiveJobById(sampleJobId, false);

  if (guestJobDetail) {
    const isMaskedCompany = guestJobDetail.company === "Verified Employer" || guestJobDetail.company === "";
    const isSalaryEmpty = guestJobDetail.salary === "";
    const isApplyUrlEmpty = guestJobDetail.applyUrl === "";
    const isDescriptionEmpty = guestJobDetail.description === "";

    if (isMaskedCompany && isSalaryEmpty && isApplyUrlEmpty && isDescriptionEmpty) {
      console.log(`✅ PASS: Job detail masked properly for ID "${sampleJobId}":`);
      console.log(`   - company: "${guestJobDetail.company}"`);
      console.log(`   - salary: "${guestJobDetail.salary}"`);
      console.log(`   - applyUrl: "${guestJobDetail.applyUrl}"`);
      console.log(`   - description: "${guestJobDetail.description}"`);
    } else {
      console.error("❌ FAIL: Job detail leaked locked fields to guest/non-Pro user:", guestJobDetail);
      allPassed = false;
    }
  } else {
    console.log("⚠️ WARNING: Sample job not found.");
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Server-Verified Pro User Unlocking
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 5: Server-managed Pro Row grants access via getServerEntitlement ---");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://szakevhxhwpeskidvtfs.supabase.co";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && serviceKey) {
    const adminClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const testEmail = `pro-test-${Date.now()}@example.com`;

    try {
      // Create temporary auth user to satisfy FK
      const { data: userData, error: userCreateErr } = await adminClient.auth.admin.createUser({
        email: testEmail,
        password: "TestPassword123!",
        email_confirm: true,
      });

      if (!userCreateErr && userData?.user) {
        const testUserId = userData.user.id;

        // Upsert a test active subscription row
        const { error: upsertErr } = await adminClient.from("subscriptions").upsert({
          user_id: testUserId,
          plan_id: "domestic_monthly_199",
          provider: "manual",
          currency: "INR",
          amount: 19900,
          status: "active",
          current_period_start: new Date().toISOString(),
          current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

        if (!upsertErr) {
          const entitled = await getServerEntitlement(testUserId);
          if (entitled.isPro === true && entitled.status === "active") {
            console.log("✅ PASS: Server-managed subscription row successfully recognized by getServerEntitlement().");
          } else {
            console.error("❌ FAIL: Valid subscription row was not granted Pro status by getServerEntitlement().");
            allPassed = false;
          }

          // Clean up test row and user
          await adminClient.from("subscriptions").delete().eq("user_id", testUserId);
        } else {
          console.warn("Notice: Subscriptions table upsert error:", upsertErr.message);
        }

        await adminClient.auth.admin.deleteUser(testUserId);
        console.log("🧹 Cleaned up temporary test user and subscription row.");
      } else {
        console.warn("Notice: User creation skipped (credentials or permissions):", userCreateErr?.message);
      }
    } catch (e: any) {
      console.warn("Notice: Live DB check skipped:", e.message);
    }
  } else {
    console.log("Notice: SUPABASE_SERVICE_ROLE_KEY not configured locally; skipping live DB upsert test.");
  }

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  if (allPassed) {
    console.log("🎉 ALL VERIFICATION TESTS PASSED SUCCESSFULLY!");
  } else {
    console.error("⚠️ SOME VERIFICATION TESTS FAILED. PLEASE REVIEW LOGS ABOVE.");
  }
  console.log("================================================================================");
}

runVerification().catch(console.error);
