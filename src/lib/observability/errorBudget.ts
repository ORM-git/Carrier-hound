/**
 * Error budget primitives (docs/slo.md "Error budget policy (BE#8)").
 * Pure and offline-testable; no I/O.
 *
 * All thresholds come from docs/slo.md - never introduce a number here
 * that the doc does not state:
 *   budget        = 0.5% of monthly uptime per availability SLI
 *   fast burn     = > 14.4x allocated rate sustained for 1 hour -> page
 *   slow burn     = > 6x allocated rate sustained for 6 hours -> issue
 *   budget spent  = feature work pauses until the monthly window resets
 * (14.4x/1h and 6x/6h are the canonical SRE multiwindow defaults the doc
 * names explicitly.)
 */

export const ERROR_BUDGET_FRACTION = 0.005;
export const FAST_BURN_MULTIPLE = 14.4;
export const FAST_BURN_WINDOW_MINUTES = 60;
export const SLOW_BURN_MULTIPLE = 6;
export const SLOW_BURN_WINDOW_MINUTES = 360;

/** Minutes in the UTC calendar month containing `at`. */
export function minutesInMonth(at: Date): number {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return days * 24 * 60;
}

/** Total error-budget minutes for the month containing `at`. */
export function monthlyBudgetMinutes(at: Date): number {
  return minutesInMonth(at) * ERROR_BUDGET_FRACTION;
}

/**
 * Burn multiple for a window: the observed bad-minute fraction divided by
 * the allocated budget fraction. 1x means "spending budget exactly as
 * allocated"; above FAST_BURN_MULTIPLE / SLOW_BURN_MULTIPLE the doc's
 * alerting rules fire.
 */
export function burnMultiple(badMinutes: number, windowMinutes: number): number {
  if (!Number.isFinite(badMinutes) || badMinutes < 0) {
    throw new RangeError("badMinutes must be finite and nonnegative");
  }
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    throw new RangeError("windowMinutes must be positive");
  }
  return badMinutes / windowMinutes / ERROR_BUDGET_FRACTION;
}

export interface ErrorBudgetStatus {
  /** Bad minutes observed in the trailing 1h / 6h / month-to-date windows. */
  badMinutes1h: number;
  badMinutes6h: number;
  badMinutesMonth: number;
  fastBurnMultiple: number;
  slowBurnMultiple: number;
  /** Share of the month's budget already spent (1 = exhausted). */
  consumptionFraction: number;
  status: "ok" | "slow_burn" | "fast_burn" | "exhausted";
}

export function evaluateErrorBudget(input: {
  now: Date;
  badMinutes1h: number;
  badMinutes6h: number;
  badMinutesMonth: number;
}): ErrorBudgetStatus {
  const { now, badMinutes1h, badMinutes6h, badMinutesMonth } = input;
  const budget = monthlyBudgetMinutes(now);
  const fast = burnMultiple(badMinutes1h, FAST_BURN_WINDOW_MINUTES);
  const slow = burnMultiple(badMinutes6h, SLOW_BURN_WINDOW_MINUTES);
  const consumption = budget === 0 ? 0 : badMinutesMonth / budget;

  let status: ErrorBudgetStatus["status"] = "ok";
  if (consumption >= 1) status = "exhausted";
  else if (fast > FAST_BURN_MULTIPLE) status = "fast_burn";
  else if (slow > SLOW_BURN_MULTIPLE) status = "slow_burn";

  return {
    badMinutes1h,
    badMinutes6h,
    badMinutesMonth,
    fastBurnMultiple: fast,
    slowBurnMultiple: slow,
    consumptionFraction: consumption,
    status,
  };
}

/**
 * Convert cron_run_logs rows into bad minutes for the digest-delivery
 * surface: the surface is down from the start of a failed run until the
 * start of the next successful run (recovery point), capped to the
 * evaluation window. Rows still "running" are not failures.
 */
export function cronFailureBadMinutes(
  runs: ReadonlyArray<{ status: string; started_at: string }>,
  windowStartMs: number,
  nowMs: number,
): number {
  const events = runs
    .map((r) => ({ status: r.status, ms: new Date(r.started_at).getTime() }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);

  let bad = 0;
  for (let i = 0; i < events.length; i++) {
    if (events[i].status !== "failed") continue;
    const failStart = events[i].ms;
    const nextSuccess = events.slice(i + 1).find((e) => e.status === "success");
    const recovery = nextSuccess ? nextSuccess.ms : nowMs;
    const from = Math.max(failStart, windowStartMs);
    const to = Math.min(recovery, nowMs);
    if (to > from) bad += (to - from) / 60000;
  }
  return bad;
}
