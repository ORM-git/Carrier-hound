#!/usr/bin/env node
/**
 * scripts/check-admin-errors.cjs
 *
 * Check for the admin error monitoring feature (error_events):
 *   1. Migration 20261121a_error_events.sql exists, is marked NOT APPLIED, and
 *      defines the expected columns with RLS + service_role-only access.
 *   2. reportRequestErrorToSentry calls recordErrorEvent.
 *   3. /api/admin/errors is gated by verifyAdminSession (403 before any read),
 *      audits the read with logAdminAction, reads a 7-day window and never
 *      selects user_id.
 *   4. /admin/errors page exists and calls the route.
 *   5. Behaviour of src/lib/monitoring/errorEvents.ts (loaded via tsx):
 *      row building (pathname only, truncation, stable hash), grouping, and
 *      recordErrorEvent never rejecting (no env, fetch throwing, fetch hanging).
 *
 * Usage: node scripts/check-admin-errors.cjs
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

// 1. Migration
const migration = read("supabase/migrations/20261121a_error_events.sql");
check("migration marked NOT APPLIED", /Status:\s+NOT APPLIED/.test(migration));
check(
  "migration names the record-migration step",
  migration.includes("node scripts/record-migration.cjs 20261121a_error_events")
);
for (const col of ["id ", "occurred_at", "route", "error_message", "stack_hash", "user_id", "count"]) {
  check(`migration defines column ${col.trim()}`, new RegExp(`^\\s+${col.trim()}\\s`, "m").test(migration));
}
check("user_id is nullable", /user_id\s+uuid null/.test(migration));
check("RLS enabled", /alter table public\.error_events enable row level security/i.test(migration));
check("client roles revoked", /revoke all on table public\.error_events from anon, authenticated/i.test(migration));
check("schema dump includes error_events", read("supabase/schema.generated.sql").includes("public.error_events"));

// 2. Reporter wiring
const reporter = read("src/lib/monitoring/sentryErrorReporter.ts");
const reqFn = reporter.slice(reporter.indexOf("export function reportRequestErrorToSentry"));
check("reportRequestErrorToSentry calls recordErrorEvent", /void recordErrorEvent\(request, error\)/.test(reqFn));

// 3. Route
const route = read("src/app/api/admin/errors/route.ts");
const authIdx = route.indexOf("verifyAdminSession(req)");
const forbidIdx = route.indexOf("status: 403");
const readIdx = route.indexOf('.from("error_events")');
check("route verifies admin session", authIdx > -1);
check("route returns 403 before reading", forbidIdx > authIdx && readIdx > forbidIdx);
check("route audits the read with logAdminAction", /logAdminAction\(\{[\s\S]*action: "error_events_read"/.test(route));
check("route reads a 7-day window", /WINDOW_DAYS = 7/.test(route) && route.includes('.gte("occurred_at", since)'));
check("route never selects user_id", !/\.select\([^)]*user_id/.test(route));
check("route groups via groupErrorEvents", route.includes("groupErrorEvents(rows)"));

// 4. Page
const page = read("src/app/admin/errors/page.tsx");
check("page fetches /api/admin/errors", page.includes('fetch("/api/admin/errors"'));

// 5. Behaviour
async function behaviour() {
  const { register } = require("tsx/cjs/api");
  const unregister = register();
  const mod = require(path.join(ROOT, "src/lib/monitoring/errorEvents.ts"));
  unregister();

  const req = new Request("https://careermonke.com/api/jobs/search?q=secret&email=a@b.c");
  const err = new Error("boom " + "x".repeat(600));
  const row = await mod.buildErrorEventRow(req, err);
  check("row route is pathname only", row.route === "/api/jobs/search");
  check("row message truncated to 500", row.error_message.length === 500);
  check("row stack_hash is 16 hex chars", /^[0-9a-f]{16}$/.test(row.stack_hash));
  check("row user_id null, count 1", row.user_id === null && row.count === 1);
  const again = await mod.buildErrorEventRow(req, err);
  check("same error hashes the same", again.stack_hash === row.stack_hash);
  const nonError = await mod.buildErrorEventRow(new Request("https://x.test/a"), "plain string");
  check("non-Error values are handled", nonError.error_message === "plain string" && nonError.stack_hash.length === 16);

  const groups = mod.groupErrorEvents([
    { route: "/a", stack_hash: "h1", error_message: "old", occurred_at: "2026-11-20T00:00:00Z", count: 1 },
    { route: "/a", stack_hash: "h1", error_message: "new", occurred_at: "2026-11-21T00:00:00Z", count: 2 },
    { route: "/a", stack_hash: "h2", error_message: "other", occurred_at: "2026-11-21T00:00:00Z", count: 1 },
    { route: "/b", stack_hash: "h1", error_message: "b", occurred_at: "2026-11-19T00:00:00Z", count: 1 },
  ]);
  check("groups by route+stack_hash", groups.length === 3);
  check("sums count, most frequent first", groups[0].route === "/a" && groups[0].stack_hash === "h1" && groups[0].count === 3);
  check("first/last seen and latest message", groups[0].first_seen === "2026-11-20T00:00:00Z" && groups[0].last_seen === "2026-11-21T00:00:00Z" && groups[0].error_message === "new");

  const env = { ...process.env };
  const realFetch = globalThis.fetch;
  try {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response(null); };
    await mod.recordErrorEvent(req, err);
    check("no service key: no insert attempted", !called);

    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    let sent = null;
    globalThis.fetch = async (url, init) => { sent = { url, init }; return new Response(null, { status: 404 }); };
    await mod.recordErrorEvent(req, err);
    check("inserts into /rest/v1/error_events", sent && sent.url === "https://db.test/rest/v1/error_events" && sent.init.method === "POST");
    check("insert body is the built row", sent && JSON.parse(sent.init.body).route === "/api/jobs/search");

    globalThis.fetch = async () => { throw new Error("network down"); };
    let threw = false;
    try { await mod.recordErrorEvent(req, err); } catch { threw = true; }
    check("fetch throwing never rejects", !threw);

    globalThis.fetch = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const t0 = Date.now();
    threw = false;
    try { await mod.recordErrorEvent(req, err); } catch { threw = true; }
    check("hanging fetch is aborted within ~2s and never rejects", !threw && Date.now() - t0 < 3500);
  } finally {
    globalThis.fetch = realFetch;
    process.env = env;
  }
}

behaviour()
  .catch((e) => {
    failed++;
    console.log(`FAIL behaviour checks crashed: ${e && e.stack ? e.stack : e}`);
  })
  .finally(() => {
    console.log(`\n[check-admin-errors] ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
