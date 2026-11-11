/**
 * scripts/test-inbound-reply-classification.ts
 *
 * Offline fixture-based test suite for header-aware inbound reply classification
 * (Backend sheet row "Reply-to / Inbound Handling").
 *
 * Verifies:
 * 1. Bounce classification via Content-Type report headers, MAILER-DAEMON, and postmaster.
 * 2. Auto-reply classification via Auto-Submitted (RFC 3834) and Precedence: auto_reply.
 * 3. Unsubscribe classification via List-Unsubscribe header and opt-out keywords.
 * 4. Human reply classification for standard incoming responses.
 * 5. Other classification for automated bulk, junk, or unrecognized mail.
 * 6. Fail-open resilience: malformed headers and unparseable contexts return "other" without crashing.
 * 7. Recipient and sender PII protection via maskEmail.
 * 8. Subprocess negative control verifying non-zero exit (code 1) on invalid conditions.
 *
 * Usage:
 *   npx tsx scripts/test-inbound-reply-classification.ts                    -> exit 0 on pass
 *   npx tsx scripts/test-inbound-reply-classification.ts --negative-control -> exit 1 on injected failure
 */

import assert from "assert";
import path from "path";
import { spawnSync } from "child_process";
import {
  classifyInboundMessage,
  InboundMessageContext,
  maskEmail,
  parseHeaderMap,
} from "./poll-inbound-replies";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`PASS: ${label}`);
  } else {
    failed++;
    console.error(`FAIL: ${label}`);
  }
}

// -----------------------------------------------------------------------------
// FIXTURES
// -----------------------------------------------------------------------------

const BOUNCE_FIXTURES: Array<{ name: string; ctx: InboundMessageContext }> = [
  {
    name: "Standard delivery status notification with report-type=delivery-status",
    ctx: {
      headers: {
        "Content-Type": 'multipart/report; report-type=delivery-status; boundary="boundary_123"',
        From: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        Subject: "Delivery Status Notification (Failure)",
      },
      snippet: "550 5.1.1 The email account that you tried to reach does not exist.",
    },
  },
  {
    name: "Bounce with MAILER-DAEMON in Return-Path",
    ctx: {
      headers: {
        "Return-Path": "<MAILER-DAEMON@mail.targetserver.com>",
        "Auto-Submitted": "auto-generated",
        Subject: "Undelivered Mail Returned to Sender",
      },
      snippet: "This is the mail system at host mail.targetserver.com. I'm sorry to have to inform you that your message could not be delivered.",
    },
  },
  {
    name: "Postmaster delivery failure notification",
    ctx: {
      headers: {
        From: "postmaster@corp.example.com",
        "Content-Type": "message/delivery-status",
        Subject: "Mail delivery failed: returning message to sender",
      },
      snippet: "A message that you sent could not be delivered to one or more of its recipients.",
    },
  },
  {
    name: "Array header format for Gmail API payload",
    ctx: {
      headers: [
        { name: "Content-Type", value: "multipart/report; report-type=delivery-status" },
        { name: "From", value: "mailer-daemon@mx.google.com" },
        { name: "Subject", value: "Failure Notice" },
      ],
      snippet: "Your message cannot be delivered.",
    },
  },
];

const AUTO_REPLY_FIXTURES: Array<{ name: string; ctx: InboundMessageContext }> = [
  {
    name: "RFC 3834 Auto-Submitted: auto-replied vacation responder",
    ctx: {
      headers: {
        "Auto-Submitted": "auto-replied",
        From: "Alex Johnson <alex.j@example.com>",
        Subject: "Automatic reply: Out of office until Monday",
      },
      snippet: "I am currently out of the office on annual leave with limited access to email.",
    },
  },
  {
    name: "Precedence: auto_reply OOO header",
    ctx: {
      headers: {
        Precedence: "auto_reply",
        From: "Sarah Connor <sarah@cyber.example>",
        Subject: "Out of Office: In a conference",
      },
      snippet: "Thank you for contacting me. I will reply to urgent matters upon my return.",
    },
  },
  {
    name: "Auto-Submitted vacation responder with custom reason",
    ctx: {
      headers: {
        "Auto-Submitted": "auto-replied (vacation)",
        From: "Devon Reed <dreed@cloud.example>",
        Subject: "Auto-Reply: Currently away",
      },
      snippet: "I am currently away from the office with no email access.",
    },
  },
];

const UNSUBSCRIBE_FIXTURES: Array<{ name: string; ctx: InboundMessageContext }> = [
  {
    name: "List-Unsubscribe header present",
    ctx: {
      headers: {
        "List-Unsubscribe": "<mailto:unsubscribe@example.com?subject=unsubscribe>",
        From: "Subscriber <sub@consumer.org>",
        Subject: "Re: Weekly Job Radar Matches",
      },
      snippet: "Please take me off your mailing list.",
    },
  },
  {
    name: "Explicit subject 'Unsubscribe'",
    ctx: {
      headers: {
        From: "Jane User <jane.u@example.com>",
        Subject: "Unsubscribe",
      },
      snippet: "Stop sending me emails.",
    },
  },
  {
    name: "Opt-out keyword in snippet body",
    ctx: {
      headers: {
        From: "Carl Smith <csmith@example.net>",
        Subject: "Re: Software Engineering Opportunity",
      },
      snippet: "Please remove me from your list and stop emailing me.",
    },
  },
];

const HUMAN_REPLY_FIXTURES: Array<{ name: string; ctx: InboundMessageContext }> = [
  {
    name: "Human reply with In-Reply-To and References headers",
    ctx: {
      headers: {
        "In-Reply-To": "<cm-job-match-789@careermonke.com>",
        References: "<cm-job-match-789@careermonke.com>",
        "Auto-Submitted": "no",
        From: "Marcus Vance <marcus.vance@tech.co>",
        Subject: "Re: Remote Tech Lead Opportunity",
      },
      snippet: "Hi team, I would love to learn more about this role. When is a good time to chat?",
    },
  },
  {
    name: "Human reply with Re: prefix without automation headers",
    ctx: {
      headers: {
        From: "Elena Rostova <elena@work.io>",
        Subject: "Re: Application Status",
      },
      snippet: "Thank you for the update! Looking forward to the interview.",
    },
  },
];

const OTHER_FIXTURES: Array<{ name: string; ctx: InboundMessageContext }> = [
  {
    name: "Precedence: bulk automated newsletter / promotional",
    ctx: {
      headers: {
        Precedence: "bulk",
        From: "Newsletter Bot <news@marketing.com>",
        Subject: "Weekly Engineering Digest",
      },
      snippet: "Here are this week's top software articles and insights.",
    },
  },
  {
    name: "Auto-Submitted: auto-generated system notification",
    ctx: {
      headers: {
        "Auto-Submitted": "auto-generated",
        From: "Alerts System <alerts@monitoring.example>",
        Subject: "Cluster CPU spike report",
      },
      snippet: "Service utilization crossed 85% at 10:14 UTC.",
    },
  },
  {
    name: "Empty / blank incoming message without reply indicators",
    ctx: {
      headers: {},
      from: "",
      subject: "",
      snippet: "",
    },
  },
];

// -----------------------------------------------------------------------------
// TEST RUNNER
// -----------------------------------------------------------------------------

export function runTests(isNegativeControl = false): void {
  console.log("================================================================================");
  console.log("     INBOUND REPLY CLASSIFICATION & PII PROTECTION TEST SUITE (OFFLINE)         ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("Running in --negative-control mode: verifying non-zero exit on intentional violation");
    // Asserting a known bounce fixture classifies as a human reply (intentional inversion)
    const result = classifyInboundMessage(BOUNCE_FIXTURES[0].ctx);
    check(
      "negative control: bounce incorrectly asserted as reply",
      result === ("reply" as unknown)
    );
    return;
  }

  // 1. Bounce classification
  console.log("1. Bounce Classification Tests");
  for (const f of BOUNCE_FIXTURES) {
    const kind = classifyInboundMessage(f.ctx);
    check(`bounce: ${f.name}`, kind === "bounce");
  }

  // 2. Auto-reply classification
  console.log("\n2. Auto-Reply Classification Tests");
  for (const f of AUTO_REPLY_FIXTURES) {
    const kind = classifyInboundMessage(f.ctx);
    check(`auto_reply: ${f.name}`, kind === "auto_reply");
  }

  // 3. Unsubscribe classification
  console.log("\n3. Unsubscribe Classification Tests");
  for (const f of UNSUBSCRIBE_FIXTURES) {
    const kind = classifyInboundMessage(f.ctx);
    check(`unsubscribe: ${f.name}`, kind === "unsubscribe");
  }

  // 4. Human reply classification
  console.log("\n4. Human Reply Classification Tests");
  for (const f of HUMAN_REPLY_FIXTURES) {
    const kind = classifyInboundMessage(f.ctx);
    check(`reply: ${f.name}`, kind === "reply");
  }

  // 5. Other classification
  console.log("\n5. Other / Automated Classification Tests");
  for (const f of OTHER_FIXTURES) {
    const kind = classifyInboundMessage(f.ctx);
    check(`other: ${f.name}`, kind === "other");
  }

  // 6. Header parsing resilience
  console.log("\n6. Header Normalization & Fail-Open Tests");
  const parsedMap = parseHeaderMap([
    { name: "AUTO-SUBMITTED", value: "  auto-replied  " },
    { name: "Content-Type", value: "text/plain" },
  ]);
  check("header map lowercases keys", parsedMap.get("auto-submitted") === "auto-replied");
  check("header map trims values", parsedMap.get("content-type") === "text/plain");

  // Fail-open on null / invalid input
  const nullKind = classifyInboundMessage(null as unknown as InboundMessageContext);
  check("null context fails open to 'other'", nullKind === "other");

  const malformedKind = classifyInboundMessage({ headers: { corrupted: 12345 as unknown as string } });
  check("malformed header values fail open to 'other'", malformedKind === "other");

  // Circular / throwing object
  const throwingCtx: InboundMessageContext = {
    get headers(): any {
      throw new Error("Simulated parse header explosion");
    },
  };
  const throwingKind = classifyInboundMessage(throwingCtx);
  check("throwing getter in context fails open gracefully to 'other'", throwingKind === "other");

  // 7. PII Masking Tests
  console.log("\n7. Recipient & Sender PII Masking Tests");
  const email1 = "john.smith@domain.com";
  const masked1 = maskEmail(email1);
  check("standard email user is masked", masked1.startsWith("jo***@") && !masked1.includes("john.smith"));
  check("domain is preserved for deliverability debugging", masked1.endsWith("@domain.com"));

  const email2 = "me@example.org";
  const masked2 = maskEmail(email2);
  check("short email user is masked", masked2.startsWith("m***@") && !masked2.includes("me@"));

  const logSentence = "Failed to process message from recruiter@company.co for candidate@personal.dev";
  const maskedSentence = maskEmail(logSentence);
  check("embedded emails in log string are masked", !maskedSentence.includes("recruiter@") && !maskedSentence.includes("candidate@personal.dev"));
  check("masked sentence retains structure", maskedSentence.includes("Failed to process message from"));

  // Empty / null safety
  check("null email returns empty string without error", maskEmail(null) === "");
  check("empty email returns empty string", maskEmail("") === "");

  // 8. Negative Control Subprocess
  console.log("\n8. Subprocess Negative Control Verification");
  const child = spawnSync(
    process.execPath,
    ["-r", "tsx", path.resolve(__filename), "--negative-control"],
    { encoding: "utf8" }
  );

  assert.strictEqual(
    child.status,
    1,
    `Subprocess with --negative-control must exit with status 1 (got status ${child.status})`
  );
  console.log("PASS: Subprocess in --negative-control mode exited with non-zero status (1)");
}

const isNegative = process.argv.includes("--negative-control");

runTests(isNegative);

console.log("\n================================================================================");
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
console.log("================================================================================");

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\nINBOUND REPLY CLASSIFICATION TEST SUITE [PASS-LOCAL]");
  process.exit(0);
}
