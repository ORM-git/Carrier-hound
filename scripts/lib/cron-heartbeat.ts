/**
 * Cron heartbeat monitoring (Backend sheet rank 35).
 *
 * Rank 34 reports fatal cron errors to Sentry as exceptions, but a cron that
 * never runs (disabled workflow, stuck runner, bad schedule) produces no
 * exception at all - failures surfaced as GitHub failure emails only. This
 * helper sends Sentry Crons check-ins so each scheduled run leaves a
 * heartbeat: "in_progress" at start, "ok" on success, "error" on fatal
 * failure. Sentry then alerts on missed or errored check-ins.
 *
 * Same guards as the rank-34 reporter: DSN-gated (no DSN = no-op, no new env
 * required), no new dependencies (global fetch), PII-free payload (cron name
 * + duration only), and fail-open - monitoring must never change a cron's
 * exit behavior.
 */

export interface CronHeartbeat {
  ok(): Promise<void>;
  error(): Promise<void>;
}

const NOOP_HEARTBEAT: CronHeartbeat = {
  async ok() {},
  async error() {},
};

/** Build the Sentry Crons check-in endpoint from a DSN; null when the DSN is absent or malformed. */
export function buildCheckInUrl(dsn: string, monitorSlug: string): string | null {
  const m = /^https:\/\/([^@/\s]+)@([^/\s]+)\/(\d+)\/?$/.exec((dsn || "").trim());
  if (!m) return null;
  const [, publicKey, host, projectId] = m;
  return `https://${host}/api/${projectId}/cron/${encodeURIComponent(monitorSlug)}/${publicKey}/`;
}

async function postCheckIn(url: string, body: Record<string, unknown>): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
    return data && typeof data.id === "string" ? data.id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start a heartbeat for one cron run. Sends the opening "in_progress"
 * check-in in the background; ok()/error() await it (fail-open) so the
 * closing check-in correlates with the opening one when Sentry returns an id.
 */
export function startCronHeartbeat(cronName: string): CronHeartbeat {
  const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || "";
  const url = buildCheckInUrl(dsn, cronName);
  if (!url) return NOOP_HEARTBEAT;

  const startedAt = Date.now();
  const opening = postCheckIn(url, { monitor_slug: cronName, status: "in_progress" });
  opening.catch(() => {}); // belt-and-braces: never an unhandled rejection

  const close = async (status: "ok" | "error"): Promise<void> => {
    try {
      const id = await opening;
      const duration = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      await postCheckIn(url, {
        ...(id ? { check_in_id: id } : {}),
        monitor_slug: cronName,
        status,
        duration,
      });
    } catch {
      // Never let monitoring break the cron's own exit path.
    }
  };

  return { ok: () => close("ok"), error: () => close("error") };
}
