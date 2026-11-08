import { probeDbHealth } from "../src/lib/health/dbHealth";

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
    // Only aggregate metrics and fixed alert codes. No names, data or errors.
    console.log(JSON.stringify(report));
    if (!report.healthy) process.exitCode = 1;
  } catch {
    console.error("DB health probe unavailable. Check migration/configuration privately.");
    process.exitCode = 1;
  }
}

void main();
