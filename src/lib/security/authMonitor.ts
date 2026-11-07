/**
 * Credential-stuffing / account-takeover monitoring.
 *
 * Detection only - no blocking semantics change. Counters live in the shared
 * Supabase rate-limit store (public.check_rate_limit RPC), so bursts are
 * visible across edge isolates. When a threshold is crossed we emit one
 * deduplicated `[ATO-ALERT]` log line per window per key; log drains /
 * dashboards turn those into alerts (owner wiring).
 *
 * Signals (grounded in the real auth flow - magic link OTP + OAuth, admin
 * bearer tokens):
 * 1. Repeated admin-token failures from one IP (token probing / stuffing).
 * 2. Repeated failures for the same presented token (replay/probing).
 * 3. Client-reported OTP-request bursts per IP.
 * 4. Client-reported OTP-request bursts per email hash.
 *
 * Client reports are untrusted hints: attackers can omit or forge them.
 * They do not establish that Supabase actually sent an OTP or that a
 * takeover happened. Provider-side auth audit alerts remain required.
 */

import { checkSharedRateLimit } from "../api/sharedRateLimit";

import { createLogger } from "@/lib/observability/logger";

const logger = createLogger({ context: { module: "security/authMonitor" } });

/** Detection thresholds. Defaults chosen for a low-traffic pre-launch app;
 *  tune as real traffic data arrives. */
export const ATO_LIMITS = {
  ADMIN_IP_FAIL: { max: 10, windowSeconds: 600 },
  ADMIN_TOKEN_FAIL: { max: 5, windowSeconds: 600 },
  OTP_IP: { max: 10, windowSeconds: 600 },
  OTP_EMAIL: { max: 5, windowSeconds: 600 },
} as const;

export interface AuthMonitorDeps {
  check?: typeof checkSharedRateLimit;
  log?: (line: string) => void;
  now?: () => number;
}

const alertDedupe = new Map<string, number>();
const ALERT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_DEDUPE_KEYS = 1024;

/** Test hook: clears the in-memory alert dedupe map. */
export function _resetAuthMonitorDedupe() {
  alertDedupe.clear();
}

async function hash16(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export function getRequestIp(req?: Request): string {
  if (!req) return "unknown";
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Increment a counter and emit a deduplicated alert when the threshold is
 * crossed. Alerts only fire on authoritative shared-store results: an
 * unavailable store degrades to silence (never a false alarm).
 */
async function countAndAlert(
  key: string,
  max: number,
  windowSeconds: number,
  alertLine: string,
  deps: AuthMonitorDeps
): Promise<void> {
  const check = deps.check ?? checkSharedRateLimit;
  const log = deps.log ?? ((line: string) => logger.error(line));
  const now = deps.now ?? Date.now;

  const result = await check(key, max, windowSeconds, undefined, { failClosed: true });
  if (result.source !== "shared" || result.allowed) return;

  const timestamp = now();
  alertDedupe.forEach((last, storedKey) => {
    if (timestamp - last >= ALERT_DEDUPE_WINDOW_MS) alertDedupe.delete(storedKey);
  });
  const lastAlert = alertDedupe.get(key);
  if (lastAlert !== undefined && timestamp - lastAlert < ALERT_DEDUPE_WINDOW_MS) return;
  if (alertDedupe.size >= MAX_DEDUPE_KEYS) {
    const oldest = alertDedupe.keys().next().value;
    if (oldest !== undefined) alertDedupe.delete(oldest);
  }
  alertDedupe.set(key, timestamp);
  log(alertLine);
}

/** Called on every failed admin session verification (verifyAdminSession). */
export async function noteAdminAuthFailure(
  req: Request | undefined,
  presentedToken: string | null,
  deps: AuthMonitorDeps = {}
): Promise<void> {
  try {
    const ip = getRequestIp(req);
    await countAndAlert(
      `ato:admin:ip:${ip}`,
      ATO_LIMITS.ADMIN_IP_FAIL.max,
      ATO_LIMITS.ADMIN_IP_FAIL.windowSeconds,
      `[ATO-ALERT] admin auth failure burst from ip=${ip} (> ${ATO_LIMITS.ADMIN_IP_FAIL.max} failures / ${ATO_LIMITS.ADMIN_IP_FAIL.windowSeconds}s) - possible token probing or credential stuffing`,
      deps
    );
    if (presentedToken) {
      const tokHash = await hash16(presentedToken);
      await countAndAlert(
        `ato:admin:tok:${tokHash}`,
        ATO_LIMITS.ADMIN_TOKEN_FAIL.max,
        ATO_LIMITS.ADMIN_TOKEN_FAIL.windowSeconds,
        `[ATO-ALERT] repeated failures for presented admin token hash=${tokHash} (> ${ATO_LIMITS.ADMIN_TOKEN_FAIL.max} / ${ATO_LIMITS.ADMIN_TOKEN_FAIL.windowSeconds}s) - possible token replay`,
        deps
      );
    }
  } catch {
    // Monitoring must never break the auth path.
  }
}

/** Called for each magic-link OTP request reported by the client. */
export async function noteOtpRequest(
  req: Request | undefined,
  email: string | null,
  deps: AuthMonitorDeps = {}
): Promise<void> {
  try {
    const ip = getRequestIp(req);
    await countAndAlert(
      `ato:otp:ip:${ip}`,
      ATO_LIMITS.OTP_IP.max,
      ATO_LIMITS.OTP_IP.windowSeconds,
      `[ATO-ALERT] magic-link request burst from ip=${ip} (> ${ATO_LIMITS.OTP_IP.max} / ${ATO_LIMITS.OTP_IP.windowSeconds}s) - possible enumeration or mail flooding`,
      deps
    );
    if (email) {
      const emailHash = await hash16(email.trim().toLowerCase());
      await countAndAlert(
        `ato:otp:email:${emailHash}`,
        ATO_LIMITS.OTP_EMAIL.max,
        ATO_LIMITS.OTP_EMAIL.windowSeconds,
        `[ATO-ALERT] magic-link request burst for email hash=${emailHash} (> ${ATO_LIMITS.OTP_EMAIL.max} / ${ATO_LIMITS.OTP_EMAIL.windowSeconds}s) - targeted account hammering`,
        deps
      );
    }
  } catch {
    // Monitoring must never break the auth path.
  }
}
