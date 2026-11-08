/**
 * Readiness evaluation for GET/HEAD /api/health/ready (Backend sheet row 49).
 *
 * Liveness (/api/health) says the process is up. Readiness says the app can do its
 * job: the environment names it needs are present and the database answers a
 * read-only query. Pure logic with injected dependencies so it can be tested offline.
 *
 * Reports only check names and states. Never environment values, never error text.
 */

export type CheckState = "ok" | "fail";

export interface ReadinessChecks {
  env: CheckState;
  database: CheckState | "skipped";
}

export interface ReadinessResult {
  ready: boolean;
  checks: ReadinessChecks;
}

export interface ReadinessInput {
  /** Resolved values by variable name. Only presence is checked. */
  env: Record<string, string | undefined>;
  /** Names that must be present and non-empty. */
  requiredEnv: string[];
  /** Read-only database check. Resolves true when the database answered. */
  probeDatabase: () => Promise<boolean>;
  /** Give up on the database check after this many ms. Pass null for no timer. */
  timeoutMs: number | null;
}

function hasValue(v: string | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

/** Parses a positive integer timeout from an env string. Anything else is null (no timer). */
export function parseTimeoutMs(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function runProbe(probe: () => Promise<boolean>, timeoutMs: number | null): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = probe().then((v) => v === true, () => false);
    if (timeoutMs === null) return await attempt;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    return await Promise.race([attempt, timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function evaluateReadiness(input: ReadinessInput): Promise<ReadinessResult> {
  const envOk = input.requiredEnv.every((name) => hasValue(input.env[name]));
  if (!envOk) {
    return { ready: false, checks: { env: "fail", database: "skipped" } };
  }
  const dbOk = await runProbe(input.probeDatabase, input.timeoutMs);
  return {
    ready: dbOk,
    checks: { env: "ok", database: dbOk ? "ok" : "fail" },
  };
}
