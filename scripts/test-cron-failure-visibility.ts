/**
 * Cron failure visibility policy test (Backend sheet rank 34).
 *
 * Static + wiring checks: every scheduled cron script reports fatal errors
 * to Sentry (DSN-gated, PII-scrubbed, flushed before exit, fail-open) via
 * the shared helper, without changing exit codes or adding dependencies.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { console.log(`PASS: ${label}`); passed += 1; }
  else { console.error(`FAIL: ${label}`); failed += 1; }
}

const HELPER = join("scripts", "lib", "cron-sentry.ts");
check(existsSync(HELPER), "cron-sentry helper exists");
const helper = readFileSync(HELPER, "utf8");
check(helper.includes('import "../../sentry.server.config"'), "helper initializes existing DSN-gated Sentry server config");
check(helper.includes("export async function reportCronFailure(cronName: string, err: unknown)"), "helper exports reportCronFailure(cronName, err)");
check(helper.includes('scope.setTag("cron", cronName)'), "events tagged with cron name");
check(helper.includes("Sentry.captureException(err)"), "errors captured via captureException");
check(helper.includes("await Sentry.flush(2000)"), "flush awaited so short-lived scripts deliver before exit");
check(/try \{[\s\S]*\} catch \{[\s\S]*\}/.test(helper), "reporting is fail-open (cannot break cron exit path)");
const helperCode = helper.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
check(!/email|recipient|user_id/.test(helperCode.replace(/@sentry|sentry/gi, "")), "helper code references no PII fields");

const CRONS: Array<[string, string, string]> = [
  ["daily-digest-cron", "daily-digest", "exit(1)"],
  ["dunning-dispatch-cron", "dunning-dispatch", "exit(2)"],
  ["early-access-digest-cron", "early-access-digest", "exit(1)"],
  ["email-retry-cron", "email-retry", "exit(1)"],
  ["retention-cron", "retention", "exit(1)"],
];
for (const [file, tag, exitCall] of CRONS) {
  const s = readFileSync(join("scripts", `${file}.ts`), "utf8");
  check(s.includes('import { reportCronFailure } from "./lib/cron-sentry";'), `${file} imports reportCronFailure`);
  check(s.includes(`await reportCronFailure("${tag}", err);`), `${file} reports fatal errors tagged "${tag}"`);
  check(s.includes(".catch(async (err) => {"), `${file} fatal catch callback is async (await is legal)`);
  check(s.includes("console.error("), `${file} preserves existing console.error`);
  check(s.includes(`process.${exitCall}`), `${file} preserves its exit code (${exitCall})`);
}

const cfg = readFileSync("sentry.server.config.ts", "utf8");
check(cfg.includes("enabled: !!SENTRY_DSN"), "Sentry stays off when DSN absent (no new env required)");

const pkg = readFileSync("package.json", "utf8");
check(!pkg.includes('"@sentry/node"'), "no new @sentry/* dependency added");

console.log(`\n[PASS-LOCAL] ${passed} cron-failure-visibility checks passed${failed ? `; ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
