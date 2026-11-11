import { probeDbHealth } from "../src/lib/health/dbHealth";
import { probeSlowQueries } from "../src/lib/health/slowQueries";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("DB health probe configuration missing (values redacted).");
    process.exitCode = 1;
    return;
  }
  try {
    const report = await probeDbHealth(url, key);
    const slowQueries = await probeSlowQueries(url, key);
    // Only aggregate metrics, fixed alert codes, and redacted slow query summaries. No raw data, names or errors.
    const fullReport = {
      ...report,
      slow_queries: slowQueries,
    };
    console.log(JSON.stringify(fullReport));
    if (!report.healthy) process.exitCode = 1;
  } catch {
    console.error("DB health probe unavailable. Check migration/configuration privately.");
    process.exitCode = 1;
  }
}

void main();
