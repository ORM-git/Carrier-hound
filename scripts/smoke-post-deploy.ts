/**
 * scripts/smoke-post-deploy.ts
 *
 * Scripted post-deploy smoke suite (Backend sheet rank 78). Run this right
 * after every production or preview deploy:
 *
 *   npx tsx scripts/smoke-post-deploy.ts                      # production
 *   npx tsx scripts/smoke-post-deploy.ts https://deploy-preview-123--careermonke.netlify.app
 *
 * Read-only checks (health endpoint, homepage render). Exits 1 with a
 * per-check report when anything fails, so a bad deploy is caught before
 * users find it. Not registered in suite-runner: it needs a live base URL.
 */
import { runSmokeChecks, SMOKE_CHECKS } from "../src/lib/monitoring/smokeChecks";

const baseUrl = process.argv[2] || process.env.SMOKE_BASE_URL || "https://careermonke.com";

async function main() {
  const { ok, results } = await runSmokeChecks(baseUrl, (url, init) => fetch(url, init));
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.status !== undefined ? ` (status ${r.status})` : ""}${r.error ? ` - ${r.error}` : ""}`);
  }
  console.log(`\nsmoke: ${results.filter((r) => r.ok).length}/${SMOKE_CHECKS.length} checks passed against ${baseUrl}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke run failed:", err?.message || err);
  process.exit(1);
});
