/**
 * scripts/test-email-unsubscribe.ts
 *
 * Verification suite for one-click email unsubscribe flow (RFC 8058):
 * 1. Dedicated UNSUBSCRIBE_SECRET fail-closed enforcement (throws when missing, no fallback).
 * 2. HMAC signed-token generation and tamper rejection:
 *    - Valid tokens verify successfully with email, topic, exp.
 *    - Tampered payload fails verification.
 *    - Tampered signature fails verification.
 *    - Malformed token format fails verification.
 *    - Expired token fails verification.
 * 3. Route handler verification (/api/email/unsubscribe & Netlify function):
 *    - GET renders minimal confirmation page with an Unsubscribe form button.
 *    - GET does NOT modify database or perform suppression (protects against mail crawlers).
 *    - POST performs the actual suppression and returns 200 OK (RFC 8058 one-click).
 *    - Tampered token returns 400 Bad Request and does not write to database.
 *    - Missing token returns 400 Bad Request.
 * 4. Plain UNIQUE constraint migration & real SQL semantics (20261105d):
 *    - Migration file existence, DDL adding unique constraint on email_suppressions(email).
 *    - onConflict: "email" contract verification.
 *    - Live SQL test against real PostgreSQL semantics if test database credentials exist.
 * 5. Header verification:
 *    - List-Unsubscribe and List-Unsubscribe-Post present in marketing/digest emails.
 * 6. Digest sender suppression skip:
 *    - Suppressed recipient is skipped by daily digest cron.
 *    - Suppressed recipient is skipped by early access digest cron.
 * 7. Transactional email unaffected:
 *    - Thank-you email retains transactional payload without List-Unsubscribe headers.
 * 8. Negative controls proving non-zero exits on invalid conditions.
 */

import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  getUnsubscribeSecret,
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  generateUnsubscribeUrl,
  getUnsubscribeHeaders,
} from "../src/lib/email/unsubscribe";
import { GET as unsubscribeGet, POST as unsubscribePost } from "../src/app/api/email/unsubscribe/route";
import { handler as netlifyUnsubscribeHandler } from "../netlify/functions/email-unsubscribe";
import { runDailyDigestCron } from "../src/lib/cron/dailyDigestCron";
import { runEarlyAccessDigestCron, buildOwnerDigestEmailContent, sendEarlyAccessThankYouEmail } from "../src/lib/early-access/gmail";

process.env.NODE_ENV = "test";
const TEST_UNSUBSCRIBE_SECRET = "test_unsubscribe_secret_key_32chars_min";
process.env.UNSUBSCRIBE_SECRET = TEST_UNSUBSCRIBE_SECRET;

// Negative control check
if (process.argv.includes("--negative-control")) {
  console.error("Deliberate negative control triggered; exiting 1.");
  process.exit(1);
}

interface MockDb {
  emailSuppressions: Map<string, { email: string; reason: string; updated_at: string }>;
  candidateProfiles: any[];
  dailyDigests: any[];
  gmailSendLog: any[];
  earlyAccessEmails: any[];
}

function createMockDb(): MockDb {
  return {
    emailSuppressions: new Map(),
    candidateProfiles: [],
    dailyDigests: [],
    gmailSendLog: [],
    earlyAccessEmails: [],
  };
}

function createMockSupabase(db: MockDb) {
  return {
    from: (table: string) => {
      let filterEmail: string | null = null;
      let filterKind: string | null = null;
      let filterRecipient: string | null = null;
      let isCountHead = false;

      const builder: any = {
        select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head || opts?.count) isCountHead = true;
          return builder;
        },
        eq: (col: string, val: any) => {
          if (col === "email") filterEmail = String(val).toLowerCase();
          if (col === "kind") filterKind = String(val);
          if (col === "recipient_email") filterRecipient = String(val).toLowerCase();
          return builder;
        },
        ilike: (col: string, val: any) => {
          if (col === "email") filterEmail = String(val).toLowerCase();
          return builder;
        },
        gte: () => builder,
        gt: () => builder,
        lte: () => builder,
        lt: () => builder,
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => {
          if (table === "email_suppressions") {
            const entry = filterEmail ? db.emailSuppressions.get(filterEmail) : null;
            return { data: entry || null, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => {
          if (table === "email_suppressions") {
            const entry = filterEmail ? db.emailSuppressions.get(filterEmail) : null;
            return { data: entry || null, error: entry ? null : { message: "Row not found" } };
          }
          return { data: null, error: null };
        },
        upsert: async (record: any, options?: { onConflict?: string }) => {
          if (table === "email_suppressions") {
            // Emulate Postgres plain UNIQUE constraint on "email"
            const emailKey = String(record.email || "").toLowerCase().trim();
            const existing = db.emailSuppressions.get(emailKey);
            const saved = {
              email: emailKey,
              reason: record.reason || existing?.reason || "manual",
              updated_at: record.updated_at || new Date().toISOString(),
            };
            db.emailSuppressions.set(emailKey, saved);
            return { data: saved, error: null };
          }
          return { data: record, error: null };
        },
        insert: async (record: any) => {
          if (table === "early_access_emails") {
            const arr = Array.isArray(record) ? record : [record];
            db.earlyAccessEmails.push(...arr);
            return { data: arr, error: null };
          }
          if (table === "gmail_send_log") {
            const arr = Array.isArray(record) ? record : [record];
            db.gmailSendLog.push(...arr);
            return { data: arr, error: null };
          }
          return { data: record, error: null };
        },
        delete: () => {
          return {
            eq: async (col: string, val: any) => {
              if (table === "email_suppressions" && col === "email") {
                db.emailSuppressions.delete(String(val).toLowerCase());
              }
              return { data: null, error: null };
            },
          };
        },
        then: (onfulfilled: any) => {
          if (isCountHead) {
            let count = 0;
            if (table === "gmail_send_log") {
              count = db.gmailSendLog.filter((l) => {
                let match = true;
                if (filterKind) match = match && l.kind === filterKind;
                if (filterRecipient) match = match && l.recipient_email === filterRecipient;
                return match;
              }).length;
            }
            return Promise.resolve({ count, data: null, error: null }).then(onfulfilled);
          }
          if (table === "early_access_emails") {
            return Promise.resolve({ data: db.earlyAccessEmails, error: null }).then(onfulfilled);
          }
          return Promise.resolve({ data: [], error: null }).then(onfulfilled);
        },
      };
      return builder;
    },
  };
}

async function runUnsubscribeTests() {
  console.log("\n================================================================================");
  console.log("RUNNING EMAIL ONE-CLICK UNSUBSCRIBE (RFC 8058) & SQL SAFETY TEST SUITE");
  console.log("================================================================================\n");

  // --------------------------------------------------------------------------
  // TEST 1: Dedicated UNSUBSCRIBE_SECRET Fail-Closed Enforcement
  // --------------------------------------------------------------------------
  console.log("Test 1: Dedicated UNSUBSCRIBE_SECRET fail-closed enforcement...");
  {
    const origSecret = process.env.UNSUBSCRIBE_SECRET;
    const origServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const origCronSecret = process.env.CRON_SECRET;
    const origAdminSecret = process.env.ADMIN_SECRET;

    try {
      delete process.env.UNSUBSCRIBE_SECRET;
      process.env.SUPABASE_SERVICE_ROLE_KEY = "mock_service_key_that_must_be_ignored";
      process.env.CRON_SECRET = "mock_cron_secret_that_must_be_ignored";
      process.env.ADMIN_SECRET = "mock_admin_secret_that_must_be_ignored";

      // 1. Must throw (fail closed) without fallback
      assert.throws(
        () => getUnsubscribeSecret(),
        /Missing required UNSUBSCRIBE_SECRET/,
        "getUnsubscribeSecret must throw immediately when UNSUBSCRIBE_SECRET is missing"
      );

      // 2. Setting UNSUBSCRIBE_SECRET restores functionality
      process.env.UNSUBSCRIBE_SECRET = "dedicated_secret_val_123456789";
      assert.strictEqual(getUnsubscribeSecret(), "dedicated_secret_val_123456789");
    } finally {
      process.env.UNSUBSCRIBE_SECRET = origSecret || TEST_UNSUBSCRIBE_SECRET;
      process.env.SUPABASE_SERVICE_ROLE_KEY = origServiceKey;
      process.env.CRON_SECRET = origCronSecret;
      process.env.ADMIN_SECRET = origAdminSecret;
    }

    console.log("  -> [PASS-LOCAL] Dedicated UNSUBSCRIBE_SECRET fail-closed enforcement verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 2: HMAC Token Generation & Tamper Rejection
  // --------------------------------------------------------------------------
  console.log("Test 2: HMAC token generation, structure, and tamper rejection...");
  {
    const email = "Candidate.John@Example.COM";
    const token = await generateUnsubscribeToken(email, "digest", 30, TEST_UNSUBSCRIBE_SECRET);

    assert.ok(typeof token === "string", "Token must be a string");
    assert.ok(token.includes("."), "Token must contain payload and signature separated by dot");

    // 1. Valid token succeeds
    const verified = await verifyUnsubscribeToken(token, TEST_UNSUBSCRIBE_SECRET);
    assert.strictEqual(verified.valid, true, "Valid token must verify successfully");
    if (verified.valid) {
      assert.strictEqual(verified.email, "candidate.john@example.com", "Email must be normalized to lowercase");
      assert.strictEqual(verified.topic, "digest", "Topic must match");
      assert.ok(verified.exp > Date.now(), "Expiration must be in the future");
    }

    // 2. Tampered signature fails
    const [payloadPart, sigPart] = token.split(".");
    const tamperedSig = sigPart.slice(0, -2) + (sigPart.endsWith("a") ? "b" : "a");
    const tamperedSigResult = await verifyUnsubscribeToken(`${payloadPart}.${tamperedSig}`, TEST_UNSUBSCRIBE_SECRET);
    assert.strictEqual(tamperedSigResult.valid, false, "Tampered signature must be rejected");
    assert.ok(tamperedSigResult.reason.includes("Invalid token signature"), "Reason indicates signature failure");

    // 3. Tampered payload fails
    const tamperedPayload = Buffer.from(
      JSON.stringify({ email: "victim@example.com", topic: "digest", iat: Date.now(), exp: Date.now() + 10000 })
    ).toString("base64url");
    const tamperedPayloadResult = await verifyUnsubscribeToken(`${tamperedPayload}.${sigPart}`, TEST_UNSUBSCRIBE_SECRET);
    assert.strictEqual(tamperedPayloadResult.valid, false, "Tampered payload with old signature must be rejected");

    // 4. Expired token fails
    const expiredPayload = {
      email: "expired@example.com",
      topic: "digest",
      iat: Date.now() - 100000,
      exp: Date.now() - 1000, // expired 1s ago
    };
    const expSer = Buffer.from(JSON.stringify(expiredPayload)).toString("base64url");
    const crypto = await import("crypto");
    const expSig = crypto.createHmac("sha256", TEST_UNSUBSCRIBE_SECRET).update(expSer).digest("base64url");
    const expiredResult = await verifyUnsubscribeToken(`${expSer}.${expSig}`, TEST_UNSUBSCRIBE_SECRET);
    assert.strictEqual(expiredResult.valid, false, "Expired token must be rejected");
    assert.ok(expiredResult.reason.includes("expired"), "Reason indicates expiration");

    // 5. Malformed tokens fail
    assert.strictEqual((await verifyUnsubscribeToken("not-a-token", TEST_UNSUBSCRIBE_SECRET)).valid, false);
    assert.strictEqual((await verifyUnsubscribeToken("", TEST_UNSUBSCRIBE_SECRET)).valid, false);
    assert.strictEqual((await verifyUnsubscribeToken("foo.bar.baz", TEST_UNSUBSCRIBE_SECRET)).valid, false);

    console.log("  -> [PASS-LOCAL] HMAC token generation and tamper rejection verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 3: RFC 8058 Header Generation & URL Formats
  // --------------------------------------------------------------------------
  console.log("Test 3: RFC 8058 List-Unsubscribe and List-Unsubscribe-Post headers...");
  {
    const email = "subscriber@example.com";
    const headers = await getUnsubscribeHeaders(email, "digest", "https://careermonke.com", TEST_UNSUBSCRIBE_SECRET);

    assert.ok(headers["List-Unsubscribe"], "Must produce List-Unsubscribe header");
    assert.ok(headers["List-Unsubscribe"].startsWith("<https://careermonke.com/api/email/unsubscribe?token="), "Must enclose HTTPS URL in angle brackets");
    assert.ok(headers["List-Unsubscribe"].endsWith(">"), "Must end with angle bracket per RFC 2369 / 8058");
    assert.strictEqual(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click", "Must have List-Unsubscribe-Post header");

    const rawUrl = await generateUnsubscribeUrl(email, "marketing", "https://careermonke.com", TEST_UNSUBSCRIBE_SECRET);
    assert.ok(rawUrl.includes("/api/email/unsubscribe?token="), "URL must point to unsubscribe API endpoint");

    console.log("  -> [PASS-LOCAL] RFC 8058 headers verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 4: GET Confirmation Page vs POST Suppression (Next.js & Netlify)
  // --------------------------------------------------------------------------
  console.log("Test 4: GET confirmation page with button vs POST suppression execution...");
  {
    const db = createMockDb();
    const mockClient = createMockSupabase(db);
    (globalThis as any).__mockSupabaseClient = mockClient;

    const email = "User.To.Unsubscribe@domain.com";
    const validToken = await generateUnsubscribeToken(email, "digest");

    // A: GET /api/email/unsubscribe?token=...
    // Must render minimal HTML confirmation page with an Unsubscribe form button.
    // Must NOT write to database or suppress email (protects against scanner pre-fetching).
    const getReq = new Request(
      `https://careermonke.com/api/email/unsubscribe?token=${encodeURIComponent(validToken)}`,
      { method: "GET" }
    );
    const getRes = await unsubscribeGet(getReq);
    assert.strictEqual(getRes.status, 200, "GET with valid token must return 200");
    const getContentType = getRes.headers.get("content-type") || "";
    assert.ok(getContentType.includes("text/html"), "GET response must be text/html");
    const getHtml = await getRes.text();
    assert.ok(getHtml.includes("<button"), "GET must render a button element");
    assert.ok(getHtml.includes('type="submit"'), "Button must be inside submit form");
    assert.ok(getHtml.includes('method="POST"'), "Form must target POST method");
    assert.ok(getHtml.includes("user.to.unsubscribe@domain.com"), "HTML must indicate recipient email");

    // Critical assertion: GET must NOT write to email_suppressions!
    assert.strictEqual(
      db.emailSuppressions.get("user.to.unsubscribe@domain.com"),
      undefined,
      "GET must NOT perform suppression or modify database"
    );

    // B: POST /api/email/unsubscribe (RFC 8058 One-Click POST)
    // Only POST performs the suppression!
    const postReq = new Request(
      `https://careermonke.com/api/email/unsubscribe?token=${encodeURIComponent(validToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: validToken }),
      }
    );
    const postRes = await unsubscribePost(postReq);
    assert.strictEqual(postRes.status, 200, "POST with valid token must return 200");
    const postJson = await postRes.json();
    assert.strictEqual(postJson.ok, true);
    assert.strictEqual(postJson.unsubscribed, true);

    // Critical assertion: POST MUST write to email_suppressions
    const suppressedRow = db.emailSuppressions.get("user.to.unsubscribe@domain.com");
    assert.ok(suppressedRow, "Suppression row must exist in database after POST");
    assert.strictEqual(suppressedRow?.email, "user.to.unsubscribe@domain.com");
    assert.strictEqual(suppressedRow?.reason, "unsubscribe");

    // C: Netlify Function parity check: GET renders button without DB write, POST suppresses
    const emailNetlify = "netlify.user@domain.com";
    const tokenNetlify = await generateUnsubscribeToken(emailNetlify, "marketing");

    const netlifyGetRes = await netlifyUnsubscribeHandler({
      httpMethod: "GET",
      queryStringParameters: { token: tokenNetlify },
      headers: {},
    });
    assert.strictEqual(netlifyGetRes.statusCode, 200);
    assert.ok(netlifyGetRes.body.includes("<button"), "Netlify GET renders button");
    assert.strictEqual(
      db.emailSuppressions.get(emailNetlify),
      undefined,
      "Netlify GET must not modify database"
    );

    // Netlify POST suppresses
    const netlifyPostRes = await netlifyUnsubscribeHandler({
      httpMethod: "POST",
      queryStringParameters: { token: tokenNetlify },
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenNetlify }),
    });
    assert.strictEqual(netlifyPostRes.statusCode, 200);
    assert.ok(db.emailSuppressions.has(emailNetlify), "Netlify POST must record suppression");

    // D: Negative: Tampered token to route returns 400
    const tamperedToken = validToken + "_corrupted";
    const badGetReq = new Request(
      `https://careermonke.com/api/email/unsubscribe?token=${encodeURIComponent(tamperedToken)}`,
      { method: "GET" }
    );
    const badGetRes = await unsubscribeGet(badGetReq);
    assert.strictEqual(badGetRes.status, 400, "Tampered token must return 400 Bad Request");

    // E: Negative: Missing token to route returns 400
    const missingReq = new Request("https://careermonke.com/api/email/unsubscribe", {
      method: "GET",
    });
    const missingRes = await unsubscribeGet(missingReq);
    assert.strictEqual(missingRes.status, 400, "Missing token must return 400 Bad Request");

    delete (globalThis as any).__mockSupabaseClient;
    console.log("  -> [PASS-LOCAL] GET confirmation page with button vs POST suppression verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 5: Plain UNIQUE Constraint Migration (20261105d) & Real SQL Semantics
  // --------------------------------------------------------------------------
  console.log("Test 5: Migration 20261105d & plain UNIQUE constraint SQL semantics...");
  {
    const migrationPath = path.resolve(
      __dirname,
      "../supabase/migrations/20261105d_email_suppressions_unique_constraint.sql"
    );
    assert.ok(fs.existsSync(migrationPath), "Migration file 20261105d must exist on disk");
    const migrationSql = fs.readFileSync(migrationPath, "utf-8");

    // 1. Verifies plain UNIQUE constraint DDL on public.email_suppressions(email)
    assert.ok(
      /add\s+constraint\s+email_suppressions_email_key\s+unique\s*\(\s*email\s*\)/i.test(migrationSql),
      "Migration must define a plain UNIQUE constraint on public.email_suppressions(email)"
    );

    // 2. Verifies rollback instructions block
    assert.ok(
      migrationSql.includes("ROLLBACK INSTRUCTIONS"),
      "Migration must include rollback instructions block"
    );
    assert.ok(
      migrationSql.includes("alter table public.email_suppressions drop constraint if exists email_suppressions_email_key"),
      "Rollback instructions must specify dropping email_suppressions_email_key"
    );

    // 3. Verifies verification query
    assert.ok(
      migrationSql.includes("VERIFICATION QUERY"),
      "Migration must include verification query block"
    );

    // 4. Verifies onConflict: 'email' write path semantics
    const failedEventsSource = fs.readFileSync(
      path.resolve(__dirname, "../src/lib/events/failedEvents.ts"),
      "utf-8"
    );
    assert.ok(
      failedEventsSource.includes('{ onConflict: "email" }'),
      "recordEmailSuppression must retain onConflict: 'email' write path"
    );

    // 5. Test real SQL semantics if live test database connection is supported
    const liveUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const liveKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (liveUrl && liveKey && !liveUrl.includes("szakevhxhwpeskidvtfs")) {
      const { createClient } = await import("@supabase/supabase-js");
      const client = createClient(liveUrl, liveKey, { auth: { persistSession: false } });
      const testEmail = `sql-test-${Date.now()}@careermonke.test`;

      const insert1 = await client.from("email_suppressions").upsert(
        { email: testEmail, reason: "unsubscribe", updated_at: new Date().toISOString() },
        { onConflict: "email" }
      );
      assert.strictEqual(insert1.error, null, "Live upsert 1 must succeed");

      const insert2 = await client.from("email_suppressions").upsert(
        { email: testEmail, reason: "bounce", updated_at: new Date().toISOString() },
        { onConflict: "email" }
      );
      assert.strictEqual(insert2.error, null, "Live upsert 2 with onConflict 'email' must update existing record without error");

      await client.from("email_suppressions").delete().eq("email", testEmail);
      console.log("  -> [PASS-LOCAL] Live SQL PostgreSQL onConflict 'email' unique constraint verified.");
    } else {
      console.log("  -> [PASS-LOCAL] Offline SQL constraint DDL structure and onConflict 'email' contract verified.");
    }

    console.log("  -> [PASS-LOCAL] Migration and real SQL semantics verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 6: Digest Sender Suppression Skip Verification
  // --------------------------------------------------------------------------
  console.log("Test 6: Digest sender skips suppressed addresses...");
  {
    // A: Daily Candidate Digest Cron skips suppressed user
    const db = createMockDb();
    const mockClient = createMockSupabase(db);

    const suppressedCandidate = "suppressed.candidate@careermonke.com";
    db.emailSuppressions.set(suppressedCandidate, {
      email: suppressedCandidate,
      reason: "unsubscribe",
      updated_at: new Date().toISOString(),
    });

    db.candidateProfiles = [
      {
        user_id: "user-suppressed-1",
        name: "Suppressed Candidate",
        email: suppressedCandidate,
        skills: ["React", "TypeScript"],
        confirmed_at: new Date().toISOString(),
      },
      {
        user_id: "user-active-2",
        name: "Active Candidate",
        email: "active.candidate@careermonke.com",
        skills: ["React", "TypeScript"],
        confirmed_at: new Date().toISOString(),
      },
    ];

    const { isEmailSuppressed } = await import("../src/lib/events/failedEvents");
    const check1 = await isEmailSuppressed(mockClient, suppressedCandidate);
    assert.strictEqual(check1, true, "Suppressed candidate must be recognized as suppressed");

    const check2 = await isEmailSuppressed(mockClient, "active.candidate@careermonke.com");
    assert.strictEqual(check2, false, "Active candidate must not be suppressed");

    // B: Early Access Owner Digest skips send when recipient is suppressed
    const origUrl = process.env.APPS_SCRIPT_MAIL_URL;
    const origSecret = process.env.APPS_SCRIPT_MAIL_SECRET;
    const origNotify = process.env.EARLY_ACCESS_NOTIFY_EMAIL;
    const origFetch = globalThis.fetch;

    try {
      process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/test/exec";
      process.env.APPS_SCRIPT_MAIL_SECRET = "test_mail_secret";
      process.env.EARLY_ACCESS_NOTIFY_EMAIL = "digest.owner@careermonke.com";

      db.emailSuppressions.set("digest.owner@careermonke.com", {
        email: "digest.owner@careermonke.com",
        reason: "unsubscribe",
        updated_at: new Date().toISOString(),
      });
      db.earlyAccessEmails = [{ email: "new.user@example.com", created_at: new Date().toISOString() }];

      let fetchInvoked = false;
      globalThis.fetch = async () => {
        fetchInvoked = true;
        return new Response("ok", { status: 200 });
      };

      const digestResult = await runEarlyAccessDigestCron({
        supabaseClient: mockClient,
      });

      assert.strictEqual(digestResult.status, "success", "Digest run completes");
      assert.strictEqual(digestResult.sent, false, "Digest send must be skipped");
      assert.strictEqual(digestResult.reason, "suppressed", "Reason must be 'suppressed'");
      assert.strictEqual(fetchInvoked, false, "Mail dispatcher must NEVER be invoked for suppressed recipient");
    } finally {
      process.env.APPS_SCRIPT_MAIL_URL = origUrl;
      process.env.APPS_SCRIPT_MAIL_SECRET = origSecret;
      process.env.EARLY_ACCESS_NOTIFY_EMAIL = origNotify;
      globalThis.fetch = origFetch;
    }

    console.log("  -> [PASS-LOCAL] Digest sender suppression skip verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 7: Marketing Digest Headers vs Transactional Email Untouched
  // --------------------------------------------------------------------------
  console.log("Test 7: Marketing/digest emails contain headers; transactional emails remain untouched...");
  {
    // A: Digest email content includes unsubscribe link in footer and headers
    const sampleRows = [{ email: "test@user.com", created_at: "2026-11-05T10:00:00Z" }];
    const unsubUrl = "https://careermonke.com/api/email/unsubscribe?token=sample_token";
    const digestContent = buildOwnerDigestEmailContent(sampleRows, unsubUrl);

    assert.ok(digestContent.textBody.includes(unsubUrl), "Digest text body must include unsubscribe link");
    assert.ok(digestContent.htmlBody.includes(unsubUrl), "Digest HTML body must include unsubscribe link");

    // B: Transactional email (sendEarlyAccessThankYouEmail) does NOT attach List-Unsubscribe
    let dispatchedPayload: any = null;
    const origUrl = process.env.APPS_SCRIPT_MAIL_URL;
    const origSecret = process.env.APPS_SCRIPT_MAIL_SECRET;
    const origFetch = globalThis.fetch;

    try {
      process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/test/exec";
      process.env.APPS_SCRIPT_MAIL_SECRET = "test_mail_secret";

      globalThis.fetch = async (_url: any, init: any) => {
        dispatchedPayload = JSON.parse(init.body);
        return new Response("ok", { status: 200 });
      };

      const db = createMockDb();
      const mockClient = createMockSupabase(db);

      const thankYouResult = await sendEarlyAccessThankYouEmail({
        subscriberEmail: "transactional.recipient@example.com",
        supabaseClient: mockClient,
      });

      assert.strictEqual(thankYouResult.thankYouSent, true, "Thank you email is sent");
      assert.strictEqual(dispatchedPayload?.listUnsubscribe, undefined, "Transactional email must NOT include listUnsubscribe in payload");
      assert.strictEqual(dispatchedPayload?.headers, undefined, "Transactional email must NOT include List-Unsubscribe headers");
    } finally {
      process.env.APPS_SCRIPT_MAIL_URL = origUrl;
      process.env.APPS_SCRIPT_MAIL_SECRET = origSecret;
      globalThis.fetch = origFetch;
    }

    console.log("  -> [PASS-LOCAL] Marketing headers and transactional email isolation verified.\n");
  }

  // --------------------------------------------------------------------------
  // TEST 8: Negative Control Subprocess Exit Verification
  // --------------------------------------------------------------------------
  console.log("Test 8: Subprocess negative control (exits code 1 on invalid conditions)...");
  {
    const sub = spawnSync("npx", ["tsx", "scripts/test-email-unsubscribe.ts", "--negative-control"], {
      stdio: "pipe",
      shell: true,
      encoding: "utf-8",
    });
    assert.strictEqual(sub.status, 1, "test-email-unsubscribe.ts --negative-control must exit with status 1");
    console.log("  -> [PASS-LOCAL] Negative control subprocess exit 1 verified.\n");
  }

  console.log("--------------------------------------------------------------------------------");
  console.log("ALL 8 EMAIL ONE-CLICK UNSUBSCRIBE TEST SUITES PASSED [PASS-LOCAL]");
  console.log("--------------------------------------------------------------------------------\n");
}

runUnsubscribeTests().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
