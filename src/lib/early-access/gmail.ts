import { getRuntimeEnv } from "@/lib/ai/serviceHandler";

export const GMAIL_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_SEND_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_TIMEOUT_MS = 5000;
export const DAILY_GMAIL_MESSAGE_CAP = 150;

export const EARLY_ACCESS_THANK_YOU_SUBJECT =
  "You're on the CareerMonke early-access list";

let lastOwnerDigestDayUtc: string | null = null;

export function _resetEarlyAccessDigestState(): void {
  lastOwnerDigestDayUtc = null;
}

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
export function sanitizeLogMessage(raw: string, config?: Partial<GmailEnvConfig>, accessToken?: string): string {
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

  // Redact any email pattern that might appear in upstream error strings
  out = out.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]"
  );

  // Redact any long token-like sequence
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

function sanitizeHeaderValue(val: string): string {
  return val.replace(/[\r\n"]/g, "").trim();
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
  timeoutMs: number = GMAIL_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getTodaySentMessageCount(
  supabaseClient: any,
  startOfDayIso: string
): Promise<{ count: number; error: boolean }> {
  if (!supabaseClient?.from) {
    return { count: 0, error: false };
  }
  try {
    const query = supabaseClient
      .from("gmail_send_log")
      .select("sent_at", { count: "exact", head: true })
      .gte("sent_at", startOfDayIso);

    const { count, error } = await query;
    if (error) {
      return { count: 0, error: true };
    }
    return { count: typeof count === "number" ? count : 0, error: false };
  } catch {
    return { count: 0, error: true };
  }
}

async function recordSentMessage(
  supabaseClient: any,
  sentAtIso: string
): Promise<void> {
  if (!supabaseClient?.from) return;
  try {
    await supabaseClient.from("gmail_send_log").insert({ sent_at: sentAtIso });
  } catch {
    safeWarn("Failed to record outgoing message in gmail_send_log");
  }
}

async function exchangeRefreshTokenForAccessToken(
  config: GmailEnvConfig
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
      GMAIL_TIMEOUT_MS
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
      `OAuth token exchange error: ${sanitizeLogMessage(err?.message || String(err), config)}`
    );
    return null;
  }
}

async function sendSingleGmailMessage(params: {
  accessToken: string;
  rawBase64Url: string;
  config: GmailEnvConfig;
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
      GMAIL_TIMEOUT_MS
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

async function fetchDigestRowsFromToday(
  supabaseClient: any,
  sinceIso: string,
  fallbackRow: { email: string; created_at: string }
): Promise<Array<{ email: string; created_at: string }>> {
  if (!supabaseClient?.from) {
    return [fallbackRow];
  }
  try {
    const query = supabaseClient
      .from("early_access_emails")
      .select("email, created_at")
      .gte("created_at", sinceIso);

    const { data, error } =
      typeof query.order === "function"
        ? await query.order("created_at", { ascending: true })
        : await query;

    if (!error && Array.isArray(data) && data.length > 0) {
      const hasCurrent = data.some((r: any) => r.email === fallbackRow.email);
      return hasCurrent ? data : [...data, fallbackRow];
    }
  } catch {}
  return [fallbackRow];
}

/**
 * Dispatches early-access emails after a NEW email is stored in early_access_emails:
 *  (a) Thank-you email to the submitter FROM the founder's Gmail
 *  (b) Batched daily digest notification to EARLY_ACCESS_NOTIFY_EMAIL (once per UTC day)
 *
 * Checks gmail_send_log (sent_at) before EACH outgoing message against DAILY_GMAIL_MESSAGE_CAP (150/day).
 * On missing env, cap hit, quota error, or network/timeout error: stops sending, logs safely, never throws.
 */
export async function dispatchEarlyAccessEmails(params: {
  subscriberEmail: string;
  createdAt: string;
  supabaseClient: any;
  cfEnv?: Record<string, any>;
}): Promise<{
  thankYouSent: boolean;
  digestSent: boolean;
  capHit: boolean;
}> {
  const isLegacy =
    process.env.NODE_ENV === "test" &&
    process.env.__CAREERMONKE_LEGACY_EARLY_ACCESS === "true";

  if (isLegacy) {
    return { thankYouSent: false, digestSent: false, capHit: false };
  }

  const config = readGmailConfig(params.cfEnv);

  if (
    !config.clientId ||
    !config.clientSecret ||
    !config.refreshToken ||
    !config.senderEmail
  ) {
    safeWarn("Missing Gmail OAuth environment configuration; skipping email send");
    return { thankYouSent: false, digestSent: false, capHit: false };
  }

  const now = new Date(params.createdAt || Date.now());
  const validNow = Number.isNaN(now.getTime()) ? new Date() : now;
  const startOfDayUtc = new Date(
    Date.UTC(
      validNow.getUTCFullYear(),
      validNow.getUTCMonth(),
      validNow.getUTCDate()
    )
  ).toISOString();
  const todayKey = startOfDayUtc.slice(0, 10);

  // 1. Check gmail_send_log before sending the thank-you email
  const beforeThankYou = await getTodaySentMessageCount(
    params.supabaseClient,
    startOfDayUtc
  );

  if (beforeThankYou.count >= DAILY_GMAIL_MESSAGE_CAP) {
    safeWarn(
      `Daily outgoing message cap (${DAILY_GMAIL_MESSAGE_CAP}) reached; skipping thank-you and digest send`
    );
    return { thankYouSent: false, digestSent: false, capHit: true };
  }

  // 2. Exchange refresh token for access token (5s timeout)
  const accessToken = await exchangeRefreshTokenForAccessToken(config);
  if (!accessToken) {
    return { thankYouSent: false, digestSent: false, capHit: false };
  }

  // 3. Build and send (a) Thank-you email to the submitter
  const thankYouContent = buildThankYouEmailContent();
  const thankYouRaw = buildRfc2822Base64UrlMessage({
    fromEmail: config.senderEmail,
    fromName: config.senderName,
    toEmail: params.subscriberEmail,
    subject: thankYouContent.subject,
    textBody: thankYouContent.textBody,
    htmlBody: thankYouContent.htmlBody,
  });

  const thankYouResult = await sendSingleGmailMessage({
    accessToken,
    rawBase64Url: thankYouRaw,
    config,
  });

  if (!thankYouResult.sent) {
    // Stop sending immediately on quota error or send failure
    return { thankYouSent: false, digestSent: false, capHit: false };
  }

  await recordSentMessage(params.supabaseClient, new Date().toISOString());

  // 4. Send (b) Owner notification batched into one daily digest email per UTC day
  if (!config.notifyEmail) {
    safeWarn("EARLY_ACCESS_NOTIFY_EMAIL is not configured; skipping owner digest send");
    return { thankYouSent: true, digestSent: false, capHit: false };
  }

  const digestAlreadySentToday =
    beforeThankYou.count > 0 || lastOwnerDigestDayUtc === todayKey;

  if (digestAlreadySentToday) {
    return { thankYouSent: true, digestSent: false, capHit: false };
  }

  // Re-check gmail_send_log before sending the second message (owner daily digest)
  const beforeDigest = await getTodaySentMessageCount(
    params.supabaseClient,
    startOfDayUtc
  );

  if (beforeDigest.count >= DAILY_GMAIL_MESSAGE_CAP) {
    safeWarn(
      `Daily outgoing message cap (${DAILY_GMAIL_MESSAGE_CAP}) reached before owner digest; skipping digest send`
    );
    return { thankYouSent: true, digestSent: false, capHit: true };
  }

  const since24hIso = new Date(validNow.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const digestRows = await fetchDigestRowsFromToday(
    params.supabaseClient,
    since24hIso,
    { email: params.subscriberEmail, created_at: params.createdAt }
  );

  const digestContent = buildOwnerDigestEmailContent(digestRows);
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
  });

  if (!digestResult.sent) {
    return { thankYouSent: true, digestSent: false, capHit: false };
  }

  lastOwnerDigestDayUtc = todayKey;
  await recordSentMessage(params.supabaseClient, new Date().toISOString());

  return { thankYouSent: true, digestSent: true, capHit: false };
}
