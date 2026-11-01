/**
 * Smoke Script: Live Database Verification for Data Correctness
 * Validates real PostgreSQL / Supabase execution:
 * - AI & Machine Learning category query against live database
 * - Exact vs estimated count execution
 * - Whole-word AI query clause against live jobs table
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getLiveJobs } from "../src/lib/jobs/service";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ SMOKE ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`✅ ${message}`);
}

async function runSmokeTests() {
  console.log("\n=======================================================");
  console.log("RUNNING LIVE DATABASE DATA-CORRECTNESS SMOKE SCRIPT");
  console.log("=======================================================\n");

  if (!supabaseUrl || !supabaseKey) {
    console.warn("⚠️ Skipping live DB smoke: Supabase environment variables not present.");
    return;
  }

  const sb = createClient(supabaseUrl, supabaseKey);

  // 1. Live AI Category Query
  console.log("--- 1. Live Query for 'ai' Category ---");
  const liveAiJobs = await getLiveJobs({ category: "ai", pageSize: 5 });
  assert(liveAiJobs.totalCount > 0, `getLiveJobs category='ai' returns non-zero results (${liveAiJobs.totalCount} jobs)`);
  assert(liveAiJobs.jobs.length > 0, `getLiveJobs category='ai' returns jobs in payload (count=${liveAiJobs.jobs.length})`);

  // 2. Live AI-ML Canonical Slug Query
  console.log("--- 2. Live Query for 'ai-machine-learning' Category ---");
  const liveAiMlJobs = await getLiveJobs({ category: "ai-machine-learning", pageSize: 5 });
  assert(liveAiMlJobs.totalCount > 0, `getLiveJobs category='ai-machine-learning' returns non-zero results (${liveAiMlJobs.totalCount} jobs)`);

  // 3. Live Data Category Query
  console.log("--- 3. Live Query for 'data' Category ---");
  const liveDataJobs = await getLiveJobs({ category: "data", pageSize: 5 });
  assert(liveDataJobs.totalCount > 0, `getLiveJobs category='data' returns non-zero results (${liveDataJobs.totalCount} jobs)`);

  // 4. Filtered vs Unfiltered Total Count
  console.log("--- 4. Live Filtered vs Unfiltered Counts ---");
  const unfiltered = await getLiveJobs({ pageSize: 5 });
  assert(unfiltered.totalCount > 1000, `Unfiltered total count is large (${unfiltered.totalCount})`);
  assert(liveAiJobs.totalCount < unfiltered.totalCount, `Filtered AI count (${liveAiJobs.totalCount}) is strictly less than total (${unfiltered.totalCount})`);

  // 5. Test Live Postgres Execution of the Whole-Word AI Clause
  console.log("--- 5. Live PostgREST Execution of Whole-Word AI Clause ---");
  const wholeWordAiClause = "category.eq.ai,category.eq.ai-ml,title.ilike.%machine learning%,title.ilike.%deep learning%,title.ilike.%llm%,title.ilike.%nlp%,title.imatch.\\yAI\\y,title.ilike.ai %,title.ilike.% ai %,title.ilike.% ai,title.ilike.ai";
  
  // Test with exact count
  const { data: exactData, count: exactCount, error: exactError } = await sb
    .from("jobs")
    .select("id, title", { count: "exact" })
    .or(wholeWordAiClause)
    .limit(5);

  assert(!exactError, `Exact count query succeeds without error (error: ${exactError?.message || "none"})`);
  assert(typeof exactCount === "number" && exactCount > 0, `Exact count returns positive number (${exactCount})`);
  assert(Boolean(exactData && exactData.length > 0), `Exact count query returns data rows (${exactData?.length})`);

  // Test with estimated count
  const { data: estData, count: estCount, error: estError } = await sb
    .from("jobs")
    .select("id, title", { count: "estimated" })
    .or(wholeWordAiClause)
    .limit(5);

  assert(!estError, `Estimated count query succeeds without error (error: ${estError?.message || "none"})`);
  assert(Boolean(estData && estData.length > 0), `Estimated count query returns data rows (${estData?.length})`);

  console.log("\n=======================================================");
  console.log("ALL LIVE DATABASE SMOKE CHECKS PASSED-LOCAL");
  console.log("=======================================================\n");
}

runSmokeTests().catch((err) => {
  console.error("Smoke check execution error:", err);
  process.exit(1);
});
