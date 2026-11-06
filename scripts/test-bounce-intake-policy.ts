#!/usr/bin/env tsx
// Bounce intake policy (Backend sheet rank 32: Bounce Handling).
//
// Pure-function coverage of the recipient extractor plus static invariants
// for scripts/bounce-intake-cron.ts:
//   1. extractor returns the single failed recipient from Gmail-style
//      bounce excerpts; null on zero or multiple candidates (never
//      auto-suppress on ambiguity);
//   2. extractor excludes daemon/noreply addresses and the sender mailbox;
//   3. the cron reuses recordEmailSuppression (reason 'bounce'), marks rows
//      processed, is pre-activation green (missing table -> exit 0), and
//      fails loudly (exit 2) on missing env or hard errors.

import { readFileSync } from "node:fs";
import { extractBounceRecipient } from "./bounce-intake-cron";

const cron = readFileSync("scripts/bounce-intake-cron.ts", "utf8");

let passed = 0;
let failed = 0;
function t(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

const GMAIL_BOUNCE = `Delivery Status Notification (Failure)
Delivery to the following recipient failed permanently:

     some.user@example.com

Technical details of permanent failure:
550 5.1.1 The email account that you tried to reach does not exist.`;

// 1. Extractor behavior.
t("parses the single failed recipient from a Gmail bounce", extractBounceRecipient(GMAIL_BOUNCE) === "some.user@example.com");
t("null on empty excerpt", extractBounceRecipient("") === null);
t("null when multiple recipients (ambiguous -> never suppress)", extractBounceRecipient("failed: a@x.com and also b@y.com both bounced") === null);
t("null when no address at all", extractBounceRecipient("delivery status notification with no address") === null);

// 2. Exclusions.
t("excludes mailer-daemon/postmaster/noreply", extractBounceRecipient("from mailer-daemon@googlemail.com to person@site.org failed") === "person@site.org");
t("excludes the sender mailbox itself", extractBounceRecipient("bounce for hello@careermonke.example and user@target.dev", "hello@careermonke.example") === "user@target.dev");
t("null when only the sender mailbox appears", extractBounceRecipient("hello@careermonke.example", "hello@careermonke.example") === null);
t("lowercases the extracted address", extractBounceRecipient("failed: User.Name@Example.COM") === "user.name@example.com");

// 3. Cron invariants.
t("consumes only unprocessed bounce_suspect rows", cron.includes('.eq("kind", "bounce_suspect")') && cron.includes('.is("processed_at", null)'));
t("suppresses via recordEmailSuppression with reason bounce", cron.includes('recordEmailSuppression(client, recipient, "bounce")'));
t("marks rows processed after handling", cron.includes('.update({ processed_at:'));
t("never suppresses on ambiguous parse (marks for review)", cron.includes("NOT suppressed"));
t("pre-activation green when the table is missing", cron.includes("exiting green") && cron.includes("42P01"));
t("exit 2 on missing env and hard errors", cron.includes("process.exit(2)"));
t("bounded batch", cron.includes("MAX_ROWS_PER_RUN"));

// 4. Reviewer nits (NO-GO fixes on PR #370).
const consoleCalls = cron.match(/console\.(log|error)\(`[^`]*`/g) ?? [];
t("no console.* call interpolates the recipient address (no PII in logs)", !consoleCalls.some((c) => c.includes("${recipient}")));
t("suppression failure leaves the row unprocessed for retry", /left unprocessed for retry/.test(cron) && /suppression failed[\s\S]{0,220}continue;/.test(cron));
t("rows marked processed only on success or deliberate ambiguous skip", cron.indexOf("continue;") < cron.indexOf('.update({ processed_at:'));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
