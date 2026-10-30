import { getRuntimeEnv, getSupabaseAdminClient } from "@/lib/ai/serviceHandler";

export const GMAIL_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_SEND_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_TIMEOUT_MS = 5000;
export const THANK_YOU_HARD_CAP_MS = 2000;
export const DAILY_GMAIL_MESSAGE_CAP = 150;

export const EARLY_ACCESS_THANK_YOU_SUBJECT =
  "You're on the CareerMonke early-access list";

interface GmailEnvConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail: string;
  senderName: string;
  notifyEmail: string;
}

function readGmailConfig(cfEnv?: Record<string, any>): GmailEnvConfig {
  const read = (key: string): string =>
    (getRuntimeEnv(key, cfEnv) || process.env[key] || "").trim();

  return {
    clientId: read("GMAIL_CLIENT_ID"),
    clientSecret: read("GMAIL_CLIENT_SECRET"),
    refreshToken: read("GMAIL_REFRESH_TOKEN"),
    senderEmail: read("GMAIL_SENDER_EMAIL"),
    senderName: read("GMAIL_SENDER_NAME") || "CareerMonke",
    notifyEmail: read("EARLY_ACCESS_NOTIFY_EMAIL"),
  };
}

/**
 * Redacts any email addresses or potential tokens/secrets from a string before logging.
 */
export function sanitizeLogMessage(
  raw: string,
  config?: Partial<GmailEnvConfig>,
  accessToken?: string
): string {
  let out = String(raw || "unknown error");
  const secrets = [
    config?.clientId,
    config?.clientSecret,
    config?.refreshToken,
    config?.senderEmail,
    config?.notifyEmail,
    accessToken,
  ].filter((val): val is string => Boolean(val && val.length >= 3));

  for (const secret of secrets) {
    out = out.split(secret).join("[REDACTED]");
  }

  out = out.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]"
  );

  out = out.replace(/\b(?:ya29|1\/\/)[A-Za-z0-9._-]+\b/g, "[REDACTED_TOKEN]");

  return out.slice(0, 240);
}

function safeWarn(message: string): void {
  console.warn(`[early-access/gmail] ${message}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function encodeUtf8SubjectHeader(subject: string): string {
  const bytes = new TextEncoder().encode(subject);
  return `=?UTF-8?B?${bytesToBase64(bytes)}?=`;
}

function assertNoHeaderInjection(val: string, fieldName: string): void {
  if (/[\r\n\0]/.test(val) || /%0[ad]/i.test(val)) {
    throw new Error(`CRLF header injection rejected in ${fieldName}`);
  }
}

function sanitizeHeaderValue(val: string): string {
  return val.replace(/[\r\n\0"]/g, "").trim();
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Builds an RFC 2822 multipart/alternative message (UTF-8 subject encoded, plain text + simple HTML)
 * and returns its base64url representation for Gmail API users/me/messages/send.
 */
export function buildRfc2822Base64UrlMessage(params: {
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}): string {
  if (
    process.env.NODE_ENV === "test" &&
    typeof (globalThis as any).__onMessageBuilderInvoked === "function"
  ) {
    (globalThis as any).__onMessageBuilderInvoked(params);
  }

  assertNoHeaderInjection(params.fromEmail, "fromEmail");
  assertNoHeaderInjection(params.toEmail, "toEmail");
  assertNoHeaderInjection(params.subject, "subject");
  if (params.fromName) {
    assertNoHeaderInjection(params.fromName, "fromName");
  }

  const boundary = "cm_early_access_mime_boundary_2026";
  const cleanName = sanitizeHeaderValue(params.fromName || "CareerMonke");
  const cleanFromEmail = sanitizeHeaderValue(params.fromEmail);
  const cleanToEmail = sanitizeHeaderValue(params.toEmail);
  const fromHeader = cleanName
    ? `"${cleanName}" <${cleanFromEmail}>`
    : `<${cleanFromEmail}>`;

  const lines = [
    `From: ${fromHeader}`,
    `To: <${cleanToEmail}>`,
    `Reply-To: <${cleanFromEmail}>`,
    `Subject: ${encodeUtf8SubjectHeader(params.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    params.textBody,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    params.htmlBody,
    "",
    `--${boundary}--`,
    "",
  ];

  const rfc2822 = lines.join("\r\n");
  return encodeBase64Url(rfc2822);
}

export function buildThankYouEmailContent(): {
  subject: string;
  textBody: string;
  htmlBody: string;
} {
  const subject = EARLY_ACCESS_THANK_YOU_SUBJECT;
  const textBody = [
    "Hi there,",
    "",
    "Thanks for joining the CareerMonke early-access list.",
    "",
    "Invites go out in small batches, and we'll email you as soon as your slot opens.",
    "",
    "No spam, ever. If you have any questions, just reply directly to this email.",
    "",
    "— CareerMonke",
  ].join("\r\n");

  const htmlBody = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:520px;">',
    "<p>Hi there,</p>",
    "<p>Thanks for joining the <strong>CareerMonke</strong> early-access list.</p>",
    "<p>Invites go out in small batches, and we&rsquo;ll email you as soon as your slot opens.</p>",
    "<p>No spam, ever. If you have any questions, just reply directly to this email.</p>",
    "<p>&mdash; CareerMonke</p>",
    "</div>",
  ].join("");

  return { subject, textBody, htmlBody };
}

export function buildOwnerDigestEmailContent(
  rows: Array<{ email: string; created_at: string }>
): {
  subject: string;
  textBody: string;
  htmlBody: string;
} {
  const count = rows.length;
  const subject =
    count === 1
      ? "CareerMonke early-access daily digest (1 new signup)"
      : `CareerMonke early-access daily digest (${count} new signups)`;

  const textLines = [
    `CareerMonke early-access daily digest (${count} signup${count === 1 ? "" : "s"}):`,
    "",
    ...rows.map((r, idx) => `${idx + 1}. ${r.email} — ${r.created_at}`),
  ];

  const htmlItems = rows
    .map(
      (r) =>
        `<li><code>${escapeHtml(r.email)}</code> &mdash; ${escapeHtml(r.created_at)}</li>`
    )
    .join("");

  const htmlBody = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;">',
    `<p><strong>CareerMonke early-access daily digest (${count} signup${
      count === 1 ? "" : "s"
    }):</strong></p>`,
    `<ol>${htmlItems}</ol>`,
    "</div>",
  ].join("");

  return {
    subject,
    textBody: textLines.join("\r\n"),
    htmlBody,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = GMAIL_TIMEOUT_MS,
  parentSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }
}

/**
 * Reads today's outgoing message count from gmail_send_log.
 * Returns ok: false if the count cannot be read (missing table, grant error, network failure).
 */
async function getTodaySentMessageCount(
  supabaseClient: any,
  startOfDayIso: string
): Promise<{ count: number; ok: boolean }> {
  if (!supabaseClient?.from) {
    return { count: 0, ok: false };
  }
  try {
    const { count, error } = await supabaseClient
      .from("gmail_send_log")
      .select("sent_at", { count: "exact", head: true })
      .gte("sent_at", startOfDayIso);

    if (error || typeof count !== "number") {
      return { count: 0, ok: false };
    }
    return { count, ok: true };
  } catch {
    return { count: 0, ok: false };
  }
}

/**
 * Double opt-in-light check: checks whether a thank-you email has EVER been sent
 * to this distinct recipient_email in gmail_send_log.
 * Fails closed (ok: false) if gmail_send_log cannot be read.
 */
async function hasThankYouEverBeenSent(
  supabaseClient: any,
  recipientEmail: string
): Promise<{ alreadySent: boolean; ok: boolean }> {
  if (!supabaseClient?.from) {
    return { alreadySent: false, ok: false };
  }
  try {
    const { count, error } = await supabaseClient
      .from("gmail_send_log")
      .select("sent_at", { count: "exact", head: true })
      .eq("kind", "thank_you")
      .eq("recipient_email", recipientEmail);

    if (error || typeof count !== "number") {
      return { alreadySent: false, ok: false };
    }
    return { alreadySent: count > 0, ok: true };
  } catch {
    return { alreadySent: false, ok: false };
  }
}

async function recordSentMessage(
  supabaseClient: any,
  row: { recipient_email: string; kind: "thank_you" | "digest"; sent_at: string }
): Promise<void> {
  if (!supabaseClient?.from) return;
  try {
    const { error } = await supabaseClient.from("gmail_send_log").insert(row);
    if (error) {
      safeWarn("Failed to record outgoing message in gmail_send_log");
    }
  } catch {
    safeWarn("Failed to record outgoing message in gmail_send_log");
  }
}

async function exchangeRefreshTokenForAccessToken(
  config: GmailEnvConfig,
  timeoutMs: number = GMAIL_TIMEOUT_MS,
  parentSignal?: AbortSignal
): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetchWithTimeout(
      GMAIL_OAUTH_TOKEN_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      },
      timeoutMs,
      parentSignal
    );

    if (!response.ok) {
      safeWarn(`OAuth token exchange failed with status ${response.status}`);
      return null;
    }

    const data = (await response.json().catch(() => null)) as {
      access_token?: string;
    } | null;

    if (!data?.access_token || typeof data.access_token !== "string") {
      safeWarn("OAuth token response missing access_token");
      return null;
    }

    return data.access_token;
  } catch (err: any) {
    safeWarn(
      `OAuth token exchange error: ${sanitizeLogMessage(
        err?.message || String(err),
        config
      )}`
    );
    return null;
  }
}

async function sendSingleGmailMessage(params: {
  accessToken: string;
  rawBase64Url: string;
  config: GmailEnvConfig;
  timeoutMs?: number;
  parentSignal?: AbortSignal;
}): Promise<{ sent: boolean; quotaExceeded: boolean }> {
  try {
    const response = await fetchWithTimeout(
      GMAIL_SEND_MESSAGE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: params.rawBase64Url }),
      },
      params.timeoutMs ?? GMAIL_TIMEOUT_MS,
      params.parentSignal
    );

    if (!response.ok) {
      const isQuota = response.status === 429 || response.status === 403;
      safeWarn(
        `Gmail send failed with status ${response.status}${
          isQuota ? " (quota/rate limit)" : ""
        }`
      );
      return { sent: false, quotaExceeded: isQuota };
    }

    return { sent: true, quotaExceeded: false };
  } catch (err: any) {
    safeWarn(
      `Gmail send request error: ${sanitizeLogMessage(
        err?.message || String(err),
        params.config,
        params.accessToken
      )}`
    );
    return { sent: false, quotaExceeded: false };
  }
}

/**
 * Sends ONLY the thank-you email to a new early-access subscriber (never sends the owner digest on the request path).
 * - Enforces a hard 2s cap (THANK_YOU_HARD_CAP_MS) so it never hangs.
 * - Fails closed if gmail_send_log cannot be read (error, missing table, grant problem).
 * - Sends at most ONE thank-you per distinct address ever (checked via gmail_send_log).
 * - Caps total outgoing messages at 150/day across gmail_send_log.
 */
export async function sendEarlyAccessThankYouEmail(params: {
  subscriberEmail: string;
  createdAt: string;
  supabaseClient: any;
  cfEnv?: Record<string, any>;
  hardCapMs?: number;
}): Promise<{
  thankYouSent: boolean;
  capHit: boolean;
  failedClosed: boolean;
  alreadyThanked: boolean;
}> {
  const isLegacy =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS === "true";

  if (isLegacy) {
    return {
      thankYouSent: false,
      capHit: false,
      failedClosed: false,
      alreadyThanked: false,
    };
  }

  // Legacy negative-control flag strictly gated to NODE_ENV === "test"
  const isLegacyFailOpen =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_CAP_FAIL_OPEN === "true";

  const config = readGmailConfig(params.cfEnv);

  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.refreshToken ||
    !config.senderEmail
  ) {
    safeWarn("Missing Gmail OAuth environment configuration; skipping thank-you send");
    return {
      thankYouSent: false,
      capHit: false,
      failedClosed: false,
      alreadyThanked: false,
    };
  }

  const normalizedEmail = params.subscriberEmail.trim().toLowerCase();
  const now = new Date(params.createdAt || Date.now());
  const validNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const startOfDayUtc = new Date(
    Date.UTC(
      validNow.getUTCFullYear(),
      validNow.getUTCMonth(),
      validNow.getUTCDate()
    )
  ).toISOString();

  // 1. Check daily outgoing message cap in gmail_send_log (MUST fail closed on read error)
  const todayCount = await getTodaySentMessageCount(
    params.supabaseClient,
    startOfDayUtc
  );

  if (!todayCount.ok && !isLegacyFailOpen) {
    safeWarn(
      "Could not read gmail_send_log daily count (failing closed); skipping thank-you send"
    );
    return {
      thankYouSent: false,
      capHit: false,
      failedClosed: true,
      alreadyThanked: false,
    };
  }

  if (todayCount.ok && todayCount.count >= DAILY_GMAIL_MESSAGE_CAP) {
    safeWarn(
      `Daily outgoing message cap (${DAILY_GMAIL_MESSAGE_CAP}) reached; skipping thank-you send`
    );
    return {
      thankYouSent: false,
      capHit: true,
      failedClosed: false,
      alreadyThanked: false,
    };
  }

  // 2. Double opt-in-light: only one thank-you email per distinct address ever (MUST fail closed on read error)
  const everSent = await hasThankYouEverBeenSent(
    params.supabaseClient,
    normalizedEmail
  );

  if (!everSent.ok && !isLegacyFailOpen) {
    safeWarn(
      "Could not verify prior thank-you history in gmail_send_log (failing closed); skipping thank-you send"
    );
    return {
      thankYouSent: false,
      capHit: false,
      failedClosed: true,
      alreadyThanked: false,
    };
  }

  if (everSent.ok && everSent.alreadySent) {
    safeWarn("Thank-you email already sent to this address previously; skipping");
    return {
      thankYouSent: false,
      capHit: false,
      failedClosed: false,
      alreadyThanked: true,
    };
  }

  // 3. Execute OAuth token exchange + Gmail send under a hard 2s cap
  const hardCapMs = params.hardCapMs ?? THANK_YOU_HARD_CAP_MS;
  const hardCapController = new AbortController();
  const hardCapTimer = setTimeout(() => hardCapController.abort(), hardCapMs);

  try {
    const accessToken = await exchangeRefreshTokenForAccessToken(
      config,
      hardCapMs,
      hardCapController.signal
    );
    if (!accessToken) {
      return {
        thankYouSent: false,
        capHit: false,
        failedClosed: false,
        alreadyThanked: false,
      };
    }

    const thankYouContent = buildThankYouEmailContent();
    const thankYouRaw = buildRfc2822Base64UrlMessage({
      fromEmail: config.senderEmail,
      fromName: config.senderName,
      toEmail: normalizedEmail,
      subject: thankYouContent.subject,
      textBody: thankYouContent.textBody,
      htmlBody: thankYouContent.htmlBody,
    });

    const thankYouResult = await sendSingleGmailMessage({
      accessToken,
      rawBase64Url: thankYouRaw,
      config,
      timeoutMs: hardCapMs,
      parentSignal: hardCapController.signal,
    });

    if (!thankYouResult.sent) {
      return {
        thankYouSent: false,
        capHit: false,
        failedClosed: false,
        alreadyThanked: false,
      };
    }

    await recordSentMessage(params.supabaseClient, {
      recipient_email: normalizedEmail,
      kind: "thank_you",
      sent_at: new Date().toISOString(),
    });

    return {
      thankYouSent: true,
      capHit: false,
      failedClosed: false,
      alreadyThanked: false,
    };
  } catch (err: any) {
    safeWarn(
      `Thank-you dispatch aborted or failed: ${sanitizeLogMessage(
        err?.message || String(err),
        config
      )}`
    );
    return {
      thankYouSent: false,
      capHit: false,
      failedClosed: false,
      alreadyThanked: false,
    };
  } finally {
    clearTimeout(hardCapTimer);
  }
}

export interface EarlyAccessDigestCronResult {
  status: "success" | "failed";
  sent: boolean;
  reason:
    | "sent"
    | "no_new_rows"
    | "dry_run"
    | "cap_hit"
    | "log_read_error"
    | "emails_read_error"
    | "missing_env"
    | "send_error";
  rowCount: number;
  lastDigestAt: string | null;
}

/**
 * Scheduled Daily Digest Cron Runner:
 * - Reads last_digest_at from gmail_send_log (MAX(sent_at) WHERE kind = 'digest').
 * - Fetches all rows in early_access_emails with created_at > last_digest_at.
 * - Sends NO email if there are no new rows.
 * - Checks the 150/day cap in gmail_send_log (failing closed on read errors).
 * - Sends ONE digest email to EARLY_ACCESS_NOTIFY_EMAIL with all new rows and records kind = 'digest' in gmail_send_log.
 */
export async function runEarlyAccessDigestCron(options?: {
  supabaseClient?: any;
  cfEnv?: Record<string, any>;
  dryRun?: boolean;
  nowIso?: string;
}): Promise<EarlyAccessDigestCronResult> {
  const dryRun = Boolean(options?.dryRun);
  const config = readGmailConfig(options?.cfEnv);

  const isLegacySendEmpty =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_DIGEST_SEND_EMPTY === "true";

  const isLegacyFailOpen =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_CAP_FAIL_OPEN === "true";

  let supabaseClient = options?.supabaseClient;
  if (!supabaseClient) {
    if (
      process.env.NODE_ENV === "test" &&
      (globalThis as any).__mockSupabaseClient !== undefined
    ) {
      supabaseClient = (globalThis as any).__mockSupabaseClient;
    } else {
      try {
        supabaseClient = getSupabaseAdminClient(options?.cfEnv, true);
      } catch {
        supabaseClient = null;
      }
    }
  }

  if (!supabaseClient?.from) {
    safeWarn("Missing Supabase client in digest cron (failing closed)");
    return {
      status: "failed",
      sent: false,
      reason: "log_read_error",
      rowCount: 0,
      lastDigestAt: null,
    };
  }

  // 1. Read last_digest_at from gmail_send_log (where kind = 'digest')
  let lastDigestAt: string | null = null;
  try {
    const { data: lastDigestRow, error: digestLookupErr } = await supabaseClient
      .from("gmail_send_log")
      .select("sent_at")
      .eq("kind", "digest")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (digestLookupErr && !isLegacyFailOpen) {
      safeWarn("Failed to read last_digest_at from gmail_send_log (failing closed)");
      return {
        status: "failed",
        sent: false,
        reason: "log_read_error",
        rowCount: 0,
        lastDigestAt: null,
      };
    }

    if (lastDigestRow?.sent_at && typeof lastDigestRow.sent_at === "string") {
      lastDigestAt = lastDigestRow.sent_at;
    }
  } catch {
    if (!isLegacyFailOpen) {
      safeWarn("Exception reading last_digest_at from gmail_send_log (failing closed)");
      return {
        status: "failed",
        sent: false,
        reason: "log_read_error",
        rowCount: 0,
        lastDigestAt: null,
      };
    }
  }

  // 2. Fetch all early_access_emails rows created since last_digest_at
  let newRows: Array<{ email: string; created_at: string }> = [];
  try {
    let query = supabaseClient
      .from("early_access_emails")
      .select("email, created_at");

    if (lastDigestAt) {
      query = query.gt("created_at", lastDigestAt);
    }

    const { data, error } = await query.order("created_at", { ascending: true });
    if (error || !Array.isArray(data)) {
      safeWarn("Failed to query new rows from early_access_emails");
      return {
        status: "failed",
        sent: false,
        reason: "emails_read_error",
        rowCount: 0,
        lastDigestAt,
      };
    }
    newRows = data;
  } catch {
    safeWarn("Exception querying new rows from early_access_emails");
    return {
      status: "failed",
      sent: false,
      reason: "emails_read_error",
      rowCount: 0,
      lastDigestAt,
    };
  }

  // 3. No digest if no new rows
  if (newRows.length === 0 && !isLegacySendEmpty) {
    return {
      status: "success",
      sent: false,
      reason: "no_new_rows",
      rowCount: 0,
      lastDigestAt,
    };
  }

  if (dryRun) {
    return {
      status: "success",
      sent: false,
      reason: "dry_run",
      rowCount: newRows.length,
      lastDigestAt,
    };
  }

  // 4. Verify Gmail env config
  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.refreshToken ||
    !config.senderEmail ||
    !config.notifyEmail
  ) {
    safeWarn("Missing Gmail or EARLY_ACCESS_NOTIFY_EMAIL configuration for digest cron");
    return {
      status: "failed",
      sent: false,
      reason: "missing_env",
      rowCount: newRows.length,
      lastDigestAt,
    };
  }

  // 5. Check 150/day outgoing message cap in gmail_send_log (fail closed if count cannot be read)
  const nowDate = options?.nowIso ? new Date(options.nowIso) : new Date();
  const validNow = Number.isNaN(nowDate.getTime()) ? new Date() : nowDate;
  const startOfDayUtc = new Date(
    Date.UTC(
      validNow.getUTCFullYear(),
      validNow.getUTCMonth(),
      validNow.getUTCDate()
    )
  ).toISOString();

  const todayCount = await getTodaySentMessageCount(supabaseClient, startOfDayUtc);
  if (!todayCount.ok && !isLegacyFailOpen) {
    safeWarn(
      "Could not read gmail_send_log daily count in digest cron (failing closed); skipping digest send"
    );
    return {
      status: "failed",
      sent: false,
      reason: "log_read_error",
      rowCount: newRows.length,
      lastDigestAt,
    };
  }

  if (todayCount.ok && todayCount.count >= DAILY_GMAIL_MESSAGE_CAP) {
    safeWarn(
      `Daily outgoing message cap (${DAILY_GMAIL_MESSAGE_CAP}) reached; skipping digest send`
    );
    return {
      status: "success",
      sent: false,
      reason: "cap_hit",
      rowCount: newRows.length,
      lastDigestAt,
    };
  }

  // 6. Exchange refresh token and send ONE digest email with all new rows
  const accessToken = await exchangeRefreshTokenForAccessToken(config, GMAIL_TIMEOUT_MS);
  if (!accessToken) {
    return {
      status: "failed",
      sent: false,
      reason: "send_error",
      rowCount: newRows.length,
      lastDigestAt,
    };
  }

  const digestContent = buildOwnerDigestEmailContent(newRows);
  const digestRaw = buildRfc2822Base64UrlMessage({
    fromEmail: config.senderEmail,
    fromName: config.senderName,
    toEmail: config.notifyEmail,
    subject: digestContent.subject,
    textBody: digestContent.textBody,
    htmlBody: digestContent.htmlBody,
  });

  const digestResult = await sendSingleGmailMessage({
    accessToken,
    rawBase64Url: digestRaw,
    config,
    timeoutMs: GMAIL_TIMEOUT_MS,
  });

  if (!digestResult.sent) {
    return {
      status: "failed",
      sent: false,
      reason: "send_error",
      rowCount: newRows.length,
      lastDigestAt,
    };
  }

  // Ensure recorded digest timestamp is >= max(created_at) of included rows so next run only picks strictly newer rows
  const latestRowCreatedAt = newRows.reduce(
    (maxIso, r) => (r.created_at > maxIso ? r.created_at : maxIso),
    ""
  );
  const currentIso = options?.nowIso || new Date().toISOString();
  const digestSentAt =
    latestRowCreatedAt && latestRowCreatedAt > currentIso
      ? latestRowCreatedAt
      : currentIso;

  await recordSentMessage(supabaseClient, {
    recipient_email: config.notifyEmail,
    kind: "digest",
    sent_at: digestSentAt,
  });

  return {
    status: "success",
    sent: true,
    reason: "sent",
    rowCount: newRows.length,
    lastDigestAt: digestSentAt,
  };
}
