/**
 * In-product error log (public.error_events, migration 20261121a). Written
 * best-effort by reportRequestErrorToSentry; read by /api/admin/errors.
 * Edge-safe: PostgREST via fetch + Web Crypto, like lib/admin/auditLog.ts.
 */

const MAX_MESSAGE_LEN = 500;
const INSERT_TIMEOUT_MS = 2000;

export interface ErrorEventRow {
  route: string;
  error_message: string;
  stack_hash: string;
  user_id: string | null;
  count: number;
}

export interface StoredErrorEvent extends ErrorEventRow {
  occurred_at: string;
}

export interface ErrorEventGroup {
  route: string;
  stack_hash: string;
  error_message: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Builds the row from server-side values only; the query string is dropped (may carry PII). */
export async function buildErrorEventRow(
  request: Request,
  error: unknown,
  userId: string | null = null
): Promise<ErrorEventRow> {
  let route = "unknown";
  try {
    route = new URL(request.url).pathname;
  } catch {
    // keep "unknown"
  }
  const err = error instanceof Error ? error : null;
  const message = (err ? `${err.name}: ${err.message}` : String(error)).slice(0, MAX_MESSAGE_LEN);
  // Hash the stack frames (not the message) so the same code path groups together
  // even when the message embeds ids; fall back to the message without a stack.
  const frames = err?.stack ? err.stack.split("\n").slice(1, 6).map((l) => l.trim()).join("\n") : "";
  const stack_hash = (await sha256Hex(frames || message)).slice(0, 16);
  return { route, error_message: message, stack_hash, user_id: userId, count: 1 };
}

/**
 * Inserts one error_events row. Never throws and never rejects: monitoring must
 * not break the request that is already failing.
 */
export async function recordErrorEvent(request: Request, error: unknown): Promise<void> {
  try {
    if (typeof window !== "undefined") return;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) return;

    const row = await buildErrorEventRow(request, error);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INSERT_TIMEOUT_MS);
    try {
      await fetch(`${supabaseUrl}/rest/v1/error_events`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(row),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // best-effort
  }
}

/** Groups rows by (route, stack_hash), summing count; most frequent first. */
export function groupErrorEvents(rows: StoredErrorEvent[]): ErrorEventGroup[] {
  const groups = new Map<string, ErrorEventGroup>();
  for (const r of rows) {
    const key = `${r.route}\u0000${r.stack_hash}`;
    const g = groups.get(key);
    const n = Number(r.count) || 1;
    if (!g) {
      groups.set(key, {
        route: r.route,
        stack_hash: r.stack_hash,
        error_message: r.error_message,
        count: n,
        first_seen: r.occurred_at,
        last_seen: r.occurred_at,
      });
      continue;
    }
    g.count += n;
    if (r.occurred_at < g.first_seen) g.first_seen = r.occurred_at;
    if (r.occurred_at > g.last_seen) {
      g.last_seen = r.occurred_at;
      g.error_message = r.error_message; // show the latest wording
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count || (a.last_seen < b.last_seen ? 1 : -1));
}
