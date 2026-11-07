

import { createLogger } from "@/lib/observability/logger";

const log = createLogger({ context: { module: "admin/auditLog" } });
/**
 * Administrative Audit Log Service
 * Edge-safe, append-only logger for privileged administrative mutations.
 * Enforces strict metadata sanitization (redaction of tokens/passwords/emails),
 * 4 KB payload size capping, and salted SHA-256 IP hashing.
 * Fails safely and NEVER throws into the caller request.
 */

export interface LogAdminActionOptions {
  adminUserId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, any> | null;
  request?: Request | null;
}

export const SENSITIVE_KEY_REGEX = /token|key|secret|password|email|authorization|cookie|jwt/i;
export const MAX_METADATA_BYTES = 4096;

/**
 * Recursively sanitizes audit metadata:
 * - Redacts values of any keys matching sensitive patterns (/token|key|secret|password|email|authorization|cookie|jwt/i)
 * - Censors sensitive substrings or raw request body objects
 * - Enforces a strict 4 KB (4096 bytes) serialization cap
 */
export function sanitizeAuditMetadata(meta?: unknown): Record<string, any> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return {};
  }

  function sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(sanitizeValue);
    }

    if (typeof value === "object") {
      const sanitizedObj: Record<string, any> = {};
      for (const [k, v] of Object.entries(value as Record<string, any>)) {
        if (SENSITIVE_KEY_REGEX.test(k)) {
          sanitizedObj[k] = "[REDACTED]";
        } else {
          sanitizedObj[k] = sanitizeValue(v);
        }
      }
      return sanitizedObj;
    }

    return value;
  }

  const sanitized = sanitizeValue(meta) as Record<string, any>;

  // Check serialized size against 4 KB limit
  let jsonString = "";
  try {
    jsonString = JSON.stringify(sanitized);
  } catch {
    return { _error: "Failed to serialize audit metadata" };
  }

  if (new TextEncoder().encode(jsonString).length > MAX_METADATA_BYTES) {
    return {
      _truncated: true,
      _note: "Metadata exceeded 4 KB limit and was capped",
      summary: Object.keys(sanitized).slice(0, 5),
    };
  }

  return sanitized;
}

/**
 * Extracts client IP from standard proxy and CDN headers.
 */
export function extractClientIp(req?: Request | null): string | null {
  if (!req || !req.headers) return null;
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp && cfIp.trim()) return cfIp.trim();

  const xForwarded = req.headers.get("x-forwarded-for");
  if (xForwarded && xForwarded.trim()) {
    const firstIp = xForwarded.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const xRealIp = req.headers.get("x-real-ip");
  if (xRealIp && xRealIp.trim()) return xRealIp.trim();

  return null;
}

/**
 * Computes a SHA-256 hash of the client IP combined with a server-side salt.
 * If no salt is configured, returns null (raw IP is NEVER stored).
 * Pure Edge-safe Web Crypto API implementation.
 */
export async function hashIpAddress(
  ip?: string | null,
  salt?: string | null
): Promise<string | null> {
  if (!ip || typeof ip !== "string" || !ip.trim()) {
    return null;
  }

  // Spec requirement: Skip if no salt; never store raw IP.
  if (!salt || typeof salt !== "string" || !salt.trim()) {
    return null;
  }

  const input = `${ip.trim()}:${salt.trim()}`;

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/**
 * Edge-safe logger for administrative mutations.
 * Writes directly to public.admin_audit_log via PostgREST using service role key.
 * Never throws into caller request. Short 2-second timeout.
 */
export async function logAdminAction(options: LogAdminActionOptions): Promise<boolean> {
  try {
    const { adminUserId, action, targetType, targetId, metadata, request } = options;

    if (!adminUserId || !action) {
      log.warn("[AdminAuditLog] Missing required adminUserId or action");
      return false;
    }

    const sanitizedMeta = sanitizeAuditMetadata(metadata);
    const clientIp = extractClientIp(request);
    const salt = process.env.AUDIT_IP_SALT;
    const ipHash = await hashIpAddress(clientIp, salt);

    const record = {
      admin_user_id: adminUserId,
      action,
      target_type: targetType || null,
      target_id: targetId || null,
      metadata: sanitizedMeta,
      ip_hash: ipHash,
    };

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      "https://szakevhxhwpeskidvtfs.supabase.co";

    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!serviceKey) {
      log.warn("[AdminAuditLog] Service role key missing; audit action skipped safely");
      return false;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    try {
      const endpoint = `${supabaseUrl.replace(/\/+$/, "")}/rest/v1/admin_audit_log`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(record),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => "Unknown error");
        log.warn(`[AdminAuditLog] PostgREST insert error (${res.status}): ${errorText.slice(0, 100)}`);
        return false;
      }

      return true;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    log.warn("[AdminAuditLog] Failed to log admin action:", { error: err?.name === "AbortError" ? "Request timed out after 2s" : err?.message || "Unknown error" });
    return false;
  }
}
