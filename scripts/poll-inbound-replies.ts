/**
 * Inbound reply poller (Backend sheet rank 14, docs/inbound-replies.md).
 *
 * Polls the sender mailbox (GMAIL_SENDER_EMAIL) via the Gmail API and
 * stores new replies in public.inbound_replies for review. Coarse kind
 * classification only; bounce/unsubscribe handling proper lives in the
 * dedicated sheet rows (38/39).
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

type InboundKind = "reply" | "bounce_suspect" | "unsubscribe_suspect";

function classify(subject: string, snippet: string): InboundKind {
  const s = `${subject}\n${snippet}`.toLowerCase();
  if (s.includes("mailer-daemon") || s.includes("undeliverable") || s.includes("delivery status notification")) {
    return "bounce_suspect";
  }
  if (s.includes("unsubscribe") || s.includes("stop emailing") || s.includes("remove me")) {
    return "unsubscribe_suspect";
  }
  return "reply";
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

  const supabase = createClient(url, serviceKey!);
  let inserted = 0;

  for (const m of messages) {
    // Dedupe first: message_id is the unique key.
    const { data: existing } = await supabase
      .from("inbound_replies")
      .select("id")
      .eq("message_id", m.id)
      .maybeSingle();
    if (existing) continue;

    const msgRes = await fetch(`${GMAIL_MESSAGES_URL}/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, {
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
    const snippet = (msg.snippet ?? "").slice(0, EXCERPT_MAX);

    // Fail-open: a failed insert never fails the poll run (matches the
    // owner decision on audit/history writes).
    const { error } = await supabase.from("inbound_replies").insert({
      message_id: m.id,
      thread_id: msg.threadId ?? m.threadId ?? null,
      from_address: get("From"),
      subject,
      body_excerpt: snippet,
      kind: classify(subject, snippet),
      received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : new Date().toISOString(),
    });
    if (error) console.warn(`Insert failed for ${m.id} (fail-open): ${error.message}`);
    else inserted++;
  }

  console.log(`Inbound poll complete: ${inserted} new repl${inserted === 1 ? "y" : "ies"} stored of ${messages.length} seen.`);
}

main().catch((err) => {
  console.error("inbound poll failed:", err);
  process.exit(1);
});
