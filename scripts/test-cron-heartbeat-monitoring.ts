/**
 * Cron heartbeat monitoring policy test (Backend sheet rank 35).
 *
 * Static + behavioral checks: every scheduled cron sends Sentry Crons
 * check-ins (in_progress -> ok/error) via the shared helper, which is
 * DSN-gated, PII-free, dependency-free and fail-open.
 * Run: npx tsx scripts/test-cron-heartbeat-monitoring.ts
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { console.log(`PASS: ${label}`); passed += 1; }
  else { console.error(`FAIL: ${label}`); failed += 1; }
}

const HELPER = join("scripts", "lib", "cron-heartbeat.ts");
check(existsSync(HELPER), "cron-heartbeat helper exists");
const helper = readFileSync(HELPER, "utf8");
check(helper.includes("export function startCronHeartbeat(cronName: string): CronHeartbeat"), "helper exports startCronHeartbeat(cronName)");
check(helper.includes("export function buildCheckInUrl(dsn: string, monitorSlug: string): string | null"), "helper exports a pure DSN -> check-in URL builder");
check(helper.includes('process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN'), "helper reuses the existing DSN env vars (no new env required)");
check(helper.includes('status: "in_progress"'), "opening check-in reports in_progress");
check(helper.includes('close("ok")') && helper.includes('close("error")'), "closing check-ins report ok and error");
check(/AbortController/.test(helper) && /ctrl\.abort\(\), 2000\)/.test(helper), "check-in POSTs are time-boxed (2s abort)");
check(/catch \{[\s\S]*?return null;[\s\S]*?\}/.test(helper), "network failures degrade to null (fail-open)");
const helperCode = helper.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
check(!/email|recipient|user_id|supabase/i.test(helperCode), "helper payload carries no PII and touches no user data");
check(!helper.includes("@sentry/"), "helper adds no @sentry/* dependency (plain fetch)");

// Behavioral checks (wrapped: repo compiles scripts as CJS, no top-level await).
async function behavioral(): Promise<void> {
  const { buildCheckInUrl, startCronHeartbeat } = require("../scripts/lib/cron-heartbeat");

  // Pure-function URL builder behavior (no network).
  const GOOD = "https://0123456789abcdef0123456789abcdef@o123.ingest.sentry.io/456";
  check(
    buildCheckInUrl(GOOD, "daily-digest") ===
      "https://o123.ingest.sentry.io/api/456/cron/daily-digest/0123456789abcdef0123456789abcdef/",
    "valid DSN maps to the Sentry Crons check-in endpoint"
  );
  check(buildCheckInUrl("", "x") === null, "empty DSN is rejected (no-op)");
  check(buildCheckInUrl("not-a-dsn", "x") === null, "malformed DSN is rejected (no-op)");
  check(buildCheckInUrl("https://key@host/notnumeric", "x") === null, "non-numeric project id is rejected");

  // No-DSN behavior: heartbeat must be a silent no-op.
  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  const t0 = Date.now();
  const hb = startCronHeartbeat("test-noop");
  await hb.ok();
  await hb.error();
  check(Date.now() - t0 < 500, "no-DSN heartbeat returns instantly without network");

  // Fail-open against an unroutable DSN (connection refused, fast).
  process.env.SENTRY_DSN = "https://0123456789abcdef0123456789abcdef@127.0.0.1:9/1";
  const hb2 = startCronHeartbeat("test-unreachable");
  await hb2.ok();
  await hb2.error();
  check(true, "unreachable Sentry ingest never throws (fail-open)");
  delete process.env.SENTRY_DSN;
}

// Wiring: all 5 scheduled crons start, close-ok and close-error the heartbeat.
const CRONS: Array<[string, string, string]> = [
  ["daily-digest-cron", "daily-digest", "exit(1)"],
  ["dunning-dispatch-cron", "dunning-dispatch", "exit(2)"],
  ["early-access-digest-cron", "early-access-digest", "exit(1)"],
  ["email-retry-cron", "email-retry", "exit(1)"],
  ["retention-cron", "retention", "exit(1)"],
];
for (const [file, tag, exitCall] of CRONS) {
  const s = readFileSync(join("scripts", `${file}.ts`), "utf8");
  check(s.includes('import { startCronHeartbeat } from "./lib/cron-heartbeat";'), `${file} imports startCronHeartbeat`);
  check(s.includes(`const heartbeat = startCronHeartbeat("${tag}");`), `${file} starts the heartbeat tagged "${tag}"`);
  check(s.includes(".then(() => heartbeat.ok())"), `${file} closes ok on success`);
  check(s.includes("await heartbeat.error();"), `${file} closes error in the fatal catch`);
  check(s.includes("main().catch(async (err)") === false && s.includes(".catch(async (err) => {"), `${file} fatal catch callback stays async`);
  check(s.includes("console.error("), `${file} preserves existing console.error`);
  check(s.includes(`process.${exitCall}`), `${file} preserves its exit code (${exitCall})`);
}

// Suite registration.
const runner = readFileSync(join("scripts", "suite-runner.ts"), "utf8");
check(runner.includes('"scripts/test-cron-heartbeat-monitoring.ts"'), "suite registered in scripts/suite-runner.ts");

behavioral()
  .then(() => {
    console.log(`\n[PASS-LOCAL] ${passed} cron-heartbeat-monitoring checks passed${failed ? `; ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error("FAIL: behavioral section threw", err);
    process.exit(1);
  });
