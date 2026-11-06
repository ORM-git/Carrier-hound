/**
 * Outbox dispatcher for dunning emails (audit BE #30).
 *
 * processFailedRenewalDunning() writes dunning_logs rows with
 * dunning_email_queued = true, but nothing used to send them. This dispatcher
 * drains that outbox: it picks queued rows oldest-first, sends the renewal
 * alert through the existing Apps Script mail route, and stamps
 * dunning_email_sent_at only on success, so a failed send is retried by the
 * next run and a row is never silently lost.
 *
 * The mark-sent update is conditional on dunning_email_sent_at still being
 * NULL, so two overlapping dispatchers cannot both claim the same row as sent
 * without the second noticing.
 */

import { dispatchAppsScriptMail, readAppsScriptConfig } from "../early-access/gmail";

export interface DunningLogRow {
  id: string;
  user_id: string;
  provider: string;
  subscription_id: string | null;
  failure_reason: string | null;
  grace_period_expires_at: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
}

export interface DunningDispatchSummary {
  scanned: number;
  sent: number;
  failed: number;
  skippedNoRecipient: number;
  cappedOut: number;
  missingMailEnv: boolean;
}

export const DUNNING_DISPATCH_BATCH_SIZE = 25;

/** Stop retrying a row after this many failed dispatch attempts. */
export const DUNNING_DISPATCH_MAX_ATTEMPTS = 5;

export function buildDunningEmailContent(params: {
  gracePeriodEnd: string | null;
  failureReason: string | null;
}): { subject: string; textBody: string; htmlBody: string } {
  const graceText = params.gracePeriodEnd
    ? new Date(params.gracePeriodEnd).toUTCString()
    : "in 7 days";
  const subject = "Action needed: your CareerMonke subscription payment failed";
  const textBody = [
    "Hi,",
    "",
    "Your latest CareerMonke subscription payment did not go through" +
      (params.failureReason ? ` (${params.failureReason})` : "") +
      ".",
    "",
    `Your Pro access continues during a grace period until ${graceText}.`,
    "Please update your payment method before then to keep your access uninterrupted.",
    "",
    "Open the app and go to the billing section to update your payment details.",
    "",
    "- The CareerMonke team",
  ].join("\n");
  const htmlBody =
    `<p>Hi,</p>` +
    `<p>Your latest CareerMonke subscription payment did not go through` +
    (params.failureReason ? ` (${escapeHtml(params.failureReason)})` : "") +
    `.</p>` +
    `<p>Your Pro access continues during a grace period until <strong>${escapeHtml(graceText)}</strong>. ` +
    `Please update your payment method before then to keep your access uninterrupted.</p>` +
    `<p>Open the app and go to the billing section to update your payment details.</p>` +
    `<p>- The CareerMonke team</p>`;
  return { subject, textBody, htmlBody };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface SupabaseLike {
  from: (table: string) => any;
}

interface MailerConfig {
  url: string;
  secret: string;
}

export async function dispatchQueuedDunningEmails(options?: {
  batchSize?: number;
  supabase?: SupabaseLike;
  mailer?: MailerConfig | null;
  cfEnv?: Record<string, any>;
  now?: Date;
}): Promise<DunningDispatchSummary> {
  const summary: DunningDispatchSummary = {
    scanned: 0,
    sent: 0,
    failed: 0,
    skippedNoRecipient: 0,
    cappedOut: 0,
    missingMailEnv: false,
  };

  const batchSize = options?.batchSize ?? DUNNING_DISPATCH_BATCH_SIZE;
  const supabase = options?.supabase;
  if (!supabase) {
    throw new Error("dispatchQueuedDunningEmails requires a supabase client");
  }
  const mailer =
    options?.mailer !== undefined ? options.mailer : readAppsScriptConfig(options?.cfEnv);
  if (!mailer || !mailer.url || !mailer.secret) {
    summary.missingMailEnv = true;
    return summary;
  }
  const now = options?.now ?? new Date();

  const { data: rows, error } = await supabase
    .from("dunning_logs")
    .select("id, user_id, provider, subscription_id, failure_reason, grace_period_expires_at, metadata, created_at")
    .eq("dunning_email_queued", true)
    .is("dunning_email_sent_at", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (error) {
    throw new Error(`dunning outbox read failed: ${error.message || error}`);
  }

  for (const row of (rows ?? []) as DunningLogRow[]) {
    summary.scanned += 1;
    const recipient = (row.metadata?.recipient_email || "").trim();
    if (!recipient) {
      // No address to send to: clear the queued flag so the row stops
      // retrying forever, and record why in metadata.
      summary.skippedNoRecipient += 1;
      await supabase
        .from("dunning_logs")
        .update({
          dunning_email_queued: false,
          metadata: { ...(row.metadata ?? {}), dispatch_error: "missing_recipient" },
        })
        .eq("id", row.id);
      continue;
    }

    const content = buildDunningEmailContent({
      gracePeriodEnd: row.grace_period_expires_at,
      failureReason: row.failure_reason,
    });

    const attempts = row.metadata?.dispatch_attempts ?? 0;
    if (attempts >= DUNNING_DISPATCH_MAX_ATTEMPTS) {
      // Retry cap reached: dequeue instead of retrying forever; the row
      // remains in dunning_logs for manual follow-up.
      summary.cappedOut += 1;
      await supabase
        .from("dunning_logs")
        .update({
          dunning_email_queued: false,
          metadata: { ...(row.metadata ?? {}), dispatch_error: "max_attempts" },
        })
        .eq("id", row.id);
      continue;
    }

    const result = await dispatchAppsScriptMail({
      url: mailer.url,
      secret: mailer.secret,
      payload: {
        email: recipient,
        to: recipient,
        recipient,
        kind: "dunning",
        subject: content.subject,
        body: content.textBody,
        textBody: content.textBody,
        htmlBody: content.htmlBody,
      },
    });

    if (result.ok || result.reply === "already") {
      // "already" means the mail route has this send on record; stamp it so
      // the outbox stops retrying a delivered email.
      // Conditional stamp: only claim the send if nobody else stamped it first.
      const { data: stamped, error: stampErr } = await supabase
        .from("dunning_logs")
        .update({ dunning_email_sent_at: now.toISOString() })
        .eq("id", row.id)
        .is("dunning_email_sent_at", null)
        .select("id");
      if (stampErr) {
        summary.failed += 1;
        console.warn(`[DunningDispatch] sent but failed to stamp ${row.id}: ${stampErr.message}`);
      } else if (stamped && stamped.length > 0) {
        summary.sent += 1;
      }
      // stamped empty: another dispatcher stamped it first; do not double-count.
    } else {
      summary.failed += 1;
      await supabase
        .from("dunning_logs")
        .update({
          metadata: {
            ...(row.metadata ?? {}),
            dispatch_attempts: (row.metadata?.dispatch_attempts ?? 0) + 1,
            last_dispatch_error: result.reply || "unknown",
            last_dispatch_at: now.toISOString(),
          },
        })
        .eq("id", row.id);
    }
  }

  return summary;
}
