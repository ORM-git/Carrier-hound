/**
 * Offline test for src/lib/health/readiness.ts and src/app/api/health/ready/route.ts
 * (Backend sheet row 49). No network, no database.
 * Run: npx tsx scripts/test-readiness.ts
 */
import fs from "node:fs";
import path from "node:path";
import { evaluateReadiness, parseTimeoutMs } from "../src/lib/health/readiness";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const REQ = ["A_URL", "A_KEY"];
const fullEnv = { A_URL: "https://x.example", A_KEY: "k" };

async function main() {
  {
    let called = false;
    const r = await evaluateReadiness({
      env: { A_URL: "https://x.example", A_KEY: "  " },
      requiredEnv: REQ,
      probeDatabase: async () => { called = true; return true; },
      timeoutMs: null,
    });
    check("blank env value: not ready, env fail, database skipped", !r.ready && r.checks.env === "fail" && r.checks.database === "skipped");
    check("database probe is not run when env fails", called === false);
  }
  {
    const r = await evaluateReadiness({ env: {}, requiredEnv: REQ, probeDatabase: async () => true, timeoutMs: null });
    check("missing env: not ready", !r.ready && r.checks.env === "fail");
  }
  {
    const r = await evaluateReadiness({ env: fullEnv, requiredEnv: REQ, probeDatabase: async () => true, timeoutMs: null });
    check("env ok and database ok: ready", r.ready && r.checks.env === "ok" && r.checks.database === "ok");
  }
  {
    const r = await evaluateReadiness({ env: fullEnv, requiredEnv: REQ, probeDatabase: async () => false, timeoutMs: null });
    check("database answers false: not ready", !r.ready && r.checks.database === "fail" && r.checks.env === "ok");
  }
  {
    const r = await evaluateReadiness({
      env: fullEnv, requiredEnv: REQ,
      probeDatabase: async () => { throw new Error("secret-detail-xyz"); },
      timeoutMs: null,
    });
    check("database probe throws: not ready, error text not in result",
      !r.ready && r.checks.database === "fail" && !JSON.stringify(r).includes("secret-detail-xyz"));
  }
  {
    const r = await evaluateReadiness({
      env: fullEnv, requiredEnv: REQ,
      probeDatabase: () => new Promise<boolean>(() => {}),
      timeoutMs: 20,
    });
    check("database probe that never answers: times out to not ready", !r.ready && r.checks.database === "fail");
  }
  {
    const r = await evaluateReadiness({
      env: fullEnv, requiredEnv: REQ,
      probeDatabase: () => new Promise<boolean>((res) => setTimeout(() => res(true), 5)),
      timeoutMs: 500,
    });
    check("database answers before the timeout: ready", r.ready);
  }
  {
    const r = await evaluateReadiness({ env: fullEnv, requiredEnv: [], probeDatabase: async () => true, timeoutMs: null });
    check("no required env names: only the database decides", r.ready);
  }

  check("parseTimeoutMs: positive integer", parseTimeoutMs("1500") === 1500);
  check("parseTimeoutMs: unset is null", parseTimeoutMs(undefined) === null);
  check("parseTimeoutMs: zero, negative, decimal, text are null",
    parseTimeoutMs("0") === null && parseTimeoutMs("-5") === null && parseTimeoutMs("1.5") === null && parseTimeoutMs("abc") === null);

  // Static checks on the route file (it imports the Supabase client, so it is read, not run).
  const route = fs.readFileSync(path.join(__dirname, "../src/app/api/health/ready/route.ts"), "utf8");
  check("route is edge runtime", /export const runtime = "edge"/.test(route));
  check("route exports GET and HEAD only", /export async function GET\b/.test(route) && /export async function HEAD\b/.test(route)
    && !/export async function (POST|PUT|PATCH|DELETE)\b/.test(route));
  check("route is no-store", /no-store/.test(route));
  check("route never uses the service role key", !/SERVICE_ROLE|SERVICE_KEY/.test(route));
  check("route probe is read-only (select, no insert/update/delete/upsert/rpc)",
    /\.select\(/.test(route) && !/\.(insert|update|delete|upsert|rpc)\(/.test(route));
  check("route does not probe the database when called without a request (build-time prerender)",
    /req \? await check\(\) : NOT_PROBED/.test(route) && (route.match(/req \? await check\(\) : NOT_PROBED/g) || []).length === 2);
  check("route returns 503 when not ready", /result\.ready \? 200 : 503/.test(route));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
