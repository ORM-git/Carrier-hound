/**
 * Inbound reply poller (Backend sheet rank 14, docs/inbound-replies.md).
 *
 * Polls the sender mailbox (GMAIL_SENDER_EMAIL) via the Gmail API and
 * stores new replies in public.inbound_replies for review. Header-aware
 * classification into reply / bounce / auto_reply / unsubscribe / other.
 *
 * Usage: npx tsx scripts/poll-inbound-replies.ts
 * Env:   INBOUND_POLL_ENABLED=true (activation gate, off by default),
 *        GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN,
 *        NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 *
 * The current OAuth grant only has gmail.send; reading needs the
 * gmail.readonly scope, which is an owner re-consent step. While the grant
 * lacks it, Gmail returns 403 and this script exits 0 with a clear message
 * (feature not activated yet), so the cron stays green pre-activation.
 *
 * Exit codes: 0 = ok / not enabled / scope pending, 1 = poll failed while
 * enabled, 2 = required env missing.
 */

import { createClient } from "@supabase/supabase-js";

const GMAIL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const EXCERPT_MAX = 2000;
const MAX_MESSAGES_PER_RUN = 25;

/**
 * Header-aware inbound classification kinds (Backend sheet row "Reply-to / Inbound Handling").
 */
export type InboundClassificationKind = "reply" | "bounce" | "auto_reply" | "unsubscribe" | "other";

/** Backward compatibility alias for legacy callers */
export type InboundKind = InboundClassificationKind;

export interface InboundHeaderMap {
  [headerName: string]: string | undefined;
}

export interface InboundMessageContext {
  headers?: InboundHeaderMap | Array<{ name: string; value: string }>;
  from?: string;
  subject?: string;
  snippet?: string;
  body?: string;
}

/**
 * Masks email addresses in text to ensure recipient/sender PII is never written to logs.
 */
export function maskEmail(text: string | null | undefined): string {
  if (!text || typeof text !== "string") return "";
  return text.replace(/([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g, (_, user: string, domain: string) => {
    if (user.length <= 2) {
      return `${user[0] || "*"}***@${domain}`;
    }
    return `${user.slice(0, 2)}***@${domain}`;
  });
}

/**
 * Normalizes headers into a case-insensitive map.
 */
export function parseHeaderMap(
  rawHeaders?: InboundHeaderMap | Array<{ name: string; value: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  if (!rawHeaders) return map;

  if (Array.isArray(rawHeaders)) {
    for (const item of rawHeaders) {
      if (item && typeof item.name === "string" && typeof item.value === "string") {
        map.set(item.name.toLowerCase().trim(), item.value.trim());
      }
    }
  } else if (typeof rawHeaders === "object") {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof key === "string" && typeof value === "string") {
        map.set(key.toLowerCase().trim(), value.trim());
      }
    }
  }

  return map;
}

/**
 * Header-aware inbound reply classifier.
 *
 * Inspects:
 * - Content-Type report headers & MAILER-DAEMON / Return-Path -> bounce
 * - Auto-Submitted (RFC 3834) & Precedence (RFC 2076) -> auto_reply / other
 * - List-Unsubscribe & explicit opt-out keywords -> unsubscribe
 * - Standard human replies (without automated headers) -> reply
 * - Fails open to "other" on unexpected input or parse errors.
 */
export function classifyInboundMessage(ctx: InboundMessageContext): InboundClassificationKind {
  try {
    if (!ctx || typeof ctx !== "object") {
      return "other";
    }

    const headers = parseHeaderMap(ctx.headers);
    const getHeader = (name: string): string => headers.get(name.toLowerCase()) || "";

    const autoSubmitted = getHeader("auto-submitted").toLowerCase();
    const precedence = getHeader("precedence").toLowerCase();
    const contentType = getHeader("content-type").toLowerCase();
    const listUnsubscribe = getHeader("list-unsubscribe");
    const returnPath = getHeader("return-path").toLowerCase();
    const inReplyTo = getHeader("in-reply-to");
    const references = getHeader("references");

    const fromAddress = (ctx.from || getHeader("from") || "").toLowerCase();
    const subject = (ctx.subject || getHeader("subject") || "").trim();
    const snippet = (ctx.snippet || ctx.body || "").trim();
    const textBlob = `${subject}\n${snippet}`.toLowerCase();

    // 1. BOUNCE: delivery failures, mailer-daemon, delivery-status reports
    const isReportContentType =
      contentType.includes("report-type=delivery-status") ||
      contentType.includes("multipart/report") ||
      contentType.includes("message/delivery-status");

    const isMailerDaemonFrom =
      fromAddress.includes("mailer-daemon") ||
      fromAddress.includes("postmaster@") ||
      returnPath.includes("mailer-daemon") ||
      returnPath.includes("postmaster@");

    const isBounceSubject =
      textBlob.includes("delivery status notification") ||
      textBlob.includes("undelivered mail returned to sender") ||
      textBlob.includes("mail delivery failed") ||
      textBlob.includes("failure notice") ||
      textBlob.includes("undeliverable:");

    if (isReportContentType || isMailerDaemonFrom || (isBounceSubject && (autoSubmitted.includes("auto-generated") || returnPath === "<>"))) {
      return "bounce";
    }

    // 2. AUTO-REPLY: out-of-office, vacation responders, automated notifications
    const isAutoSubmittedReply =
      autoSubmitted.includes("auto-replied") ||
      (autoSubmitted.length > 0 && autoSubmitted !== "no" && !autoSubmitted.includes("auto-generated"));

    const isPrecedenceAutoReply = precedence === "auto_reply";

    const isOutOfOfficeSubject =
      /^automatic reply:/i.test(subject) ||
      /^out of office:/i.test(subject) ||
      /^auto-reply:/i.test(subject) ||
      /^autoresponse:/i.test(subject) ||
      /i am (currently )?(out of the office|away from the office|on leave)/i.test(snippet);

    if (isAutoSubmittedReply || isPrecedenceAutoReply || (isOutOfOfficeSubject && autoSubmitted !== "no")) {
      return "auto_reply";
    }

    // 3. UNSUBSCRIBE: List-Unsubscribe header or explicit opt-out intent
    const hasListUnsubscribeHeader = Boolean(listUnsubscribe && listUnsubscribe.trim().length > 0);

    const isExplicitUnsubscribeText =
      /\b(unsubscribe|stop emailing|remove me|opt[ -]?out|take me off (your|the) list)\b/i.test(textBlob);

    if (hasListUnsubscribeHeader || isExplicitUnsubscribeText) {
      return "unsubscribe";
    }

    // 4. OTHER: Bulk / junk / system notifications that are neither bounces nor human replies
    if (precedence === "bulk" || precedence === "junk" || precedence === "list" || autoSubmitted === "auto-generated") {
      return "other";
    }

    // 5. HUMAN REPLY: Normal conversation response
    const hasReplyIndicators =
      inReplyTo.length > 0 ||
      references.length > 0 ||
      /^(re|fwd|fw):\s*/i.test(subject) ||
      (subject.length > 0 && fromAddress.length > 0 && autoSubmitted !== "auto-generated");

    if (hasReplyIndicators && autoSubmitted !== "auto-generated") {
      return "reply";
    }

    return "other";
  } catch (_err) {
    // Fail-open on any parse error
    return "other";
  }
}

/** Backward compatibility wrapper */
export function classify(subject: string, snippet: string, headers?: InboundHeaderMap | Array<{ name: string; value: string }>): InboundClassificationKind {
  return classifyInboundMessage({ subject, snippet, headers });
}

async function getAccessToken(): Promise<string | null> {
  const res = await fetch(GMAIL_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID || "",
      client_secret: process.env.GMAIL_CLIENT_SECRET || "",
      refresh_token: process.env.GMAIL_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return typeof data?.access_token === "string" ? data.access_token : null;
}

async function main() {
  if (process.env.INBOUND_POLL_ENABLED !== "true") {
    console.log("INBOUND_POLL_ENABLED is not true; inbound polling is off (docs/inbound-replies.md).");
    return;
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey || !process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    console.error("Required env missing (Supabase + Gmail OAuth).");
    process.exit(2);
  }

  const token = await getAccessToken();
  if (!token) {
    console.error("Gmail OAuth token exchange failed.");
    process.exit(1);
  }

  const listRes = await fetch(
    `${GMAIL_MESSAGES_URL}?q=${encodeURIComponent("in:inbox newer_than:2d")}&maxResults=${MAX_MESSAGES_PER_RUN}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (listRes.status === 403) {
    console.log(
      "Gmail returned 403: the OAuth grant lacks gmail.readonly. Owner re-consent step pending (docs/inbound-replies.md); treating as not-yet-activated.",
    );
    return;
  }
  if (!listRes.ok) {
    console.error(`Gmail list failed with status ${listRes.status}.`);
    process.exit(1);
  }

  const list = (await listRes.json()) as { messages?: Array<{ id: string; threadId?: string }> };
  const messages = list.messages ?? [];
  if (messages.length === 0) {
    console.log("No recent inbox messages.");
    return;
  }

  const supabase = createClient(url, serviceKey);
  let inserted = 0;

  const METADATA_HEADERS = [
    "From",
    "Subject",
    "Date",
    "Auto-Submitted",
    "Precedence",
    "List-Unsubscribe",
    "Content-Type",
    "Return-Path",
    "In-Reply-To",
    "References",
  ];
  const metadataParams = METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");

  for (const m of messages) {
    // Dedupe first: message_id is the unique key.
    const { data: existing } = await supabase
      .from("inbound_replies")
      .select("id")
      .eq("message_id", m.id)
      .maybeSingle();
    if (existing) continue;

    const msgRes = await fetch(`${GMAIL_MESSAGES_URL}/${m.id}?format=metadata&${metadataParams}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!msgRes.ok) {
      console.warn(`Skipping ${m.id}: fetch returned ${msgRes.status}.`);
      continue;
    }
    const msg = (await msgRes.json()) as {
      threadId?: string;
      snippet?: string;
      internalDate?: string;
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    const headers = msg.payload?.headers ?? [];
    const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    const subject = get("Subject");
    const fromAddress = get("From");
    const snippet = (msg.snippet ?? "").slice(0, EXCERPT_MAX);

    const classification = classifyInboundMessage({
      headers,
      from: fromAddress,
      subject,
      snippet,
    });

    // Fail-open: a failed insert never fails the poll run (matches the
    // owner decision on audit/history writes). Never log recipient PII.
    const { error } = await supabase.from("inbound_replies").insert({
      message_id: m.id,
      thread_id: msg.threadId ?? m.threadId ?? null,
      from_address: fromAddress,
      subject,
      body_excerpt: snippet,
      kind: classification,
      received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    });
    if (error) {
      console.warn(`Insert failed for ${m.id} (fail-open): ${maskEmail(error.message)}`);
    } else {
      inserted++;
    }
  }

  console.log(`Inbound poll complete: ${inserted} new repl${inserted === 1 ? "y" : "ies"} stored of ${messages.length} seen.`);
}

if (process.argv[1] && process.argv[1].endsWith("poll-inbound-replies.ts")) {
  main().catch((err) => {
    console.error("inbound poll failed:", maskEmail(err?.message || String(err)));
    process.exit(1);
  });
}
