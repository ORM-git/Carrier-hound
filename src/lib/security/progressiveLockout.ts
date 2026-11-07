/**
 * Progressive brute-force lockout (Backend sheet rank 68).
 *
 * Supabase Auth throttles its own endpoints and public forms have per-IP
 * rate limits, but nothing escalates: an attacker could spread attempts
 * just under every per-window limit forever. This module adds app-level
 * progressive lockout on top of the existing ATO monitoring
 * (authMonitor.ts, alert-only), keyed on the same shared rate-limit
 * store (migration 20261020 check_rate_limit - atomic increment; a live
 * window's expires_at is never extended).
 *
 * Design notes (read before changing):
 *  - isLockedOut is READ-ONLY: it peeks the failure counters with a
 *    plain SELECT (peekSharedRateLimitCount) and never increments.
 *    Only recordFailureAndMaybeLock increments, once per failed
 *    verification. A successful request therefore never moves the
 *    counters and can never trip a step, no matter how often it runs.
 *  - Thresholds count failed verifications only: the soft step trips on
 *    more than 8 failed admin verifications per 10 minutes from one IP,
 *    the later steps on sustained failure volume. An online guessing
 *    attack produces exactly that shape; ordinary admin use (even
 *    hundreds of successful checks an hour) produces none.
 *  - A lock lasts only until the tripped counter's window expires;
 *    there is nothing to reset and nothing an attacker can extend.
 *    A false trip self-heals when the short window expires. Sustained abuse trips the longer windows, which
 *    is what makes the lockout progressive.
 *  - A lock lasts only until the tripped counter's window expires;
 *    there is nothing to reset and nothing an attacker can extend.
 *  - Failure mode: fail OPEN. If the shared store is unavailable the
 *    answer is "not locked", so a Supabase/Redis outage can never lock
 *    out the owner (the fail-closed side is alerting in authMonitor.ts).
 */

import { checkSharedRateLimit, peekSharedRateLimitCount } from "../api/sharedRateLimit";

export interface LockoutStep {
  failures: number;
  withinSeconds: number;
}

/** Chosen defaults for a low-traffic pre-launch app; tune with real data. */
export const LOCKOUT_STEPS: readonly LockoutStep[] = [
  { failures: 8, withinSeconds: 600 },
  { failures: 20, withinSeconds: 3600 },
  { failures: 50, withinSeconds: 21600 },
] as const;

export interface LockoutDeps {
  check?: typeof checkSharedRateLimit;
  peek?: typeof peekSharedRateLimitCount;
}

export interface LockoutStatus {
  locked: boolean;
  /** Which step tripped, when locked. Its withinSeconds bounds the wait. */
  step?: LockoutStep;
}

async function hashId(scope: string, identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`lockout:${scope}:${identifier}`)
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

async function countFor(
  check: typeof checkSharedRateLimit,
  scope: string,
  id: string,
  step: LockoutStep,
  max: number
) {
  const result = await check(
    `fail:${scope}:${id}:${step.withinSeconds}`,
    max,
    step.withinSeconds,
    undefined,
    { failClosed: false }
  );
  return result.source === "shared" ? result : null;
}

/** True only when the shared store confirms a tripped failure counter. */
export async function isLockedOut(
  scope: string,
  identifier: string,
  deps: LockoutDeps = {},
  steps: readonly LockoutStep[] = LOCKOUT_STEPS
): Promise<LockoutStatus> {
  const peek = deps.peek ?? peekSharedRateLimitCount;
  const id = await hashId(scope, identifier);
  try {
    let worst: LockoutStep | null = null;
    for (const step of steps) {
      const r = await peek(`fail:${scope}:${id}:${step.withinSeconds}`);
      if (r && r.count > step.failures) {
        if (!worst || step.withinSeconds > worst.withinSeconds) worst = step;
      }
    }
    return worst ? { locked: true, step: worst } : { locked: false };
  } catch {
    return { locked: false };
  }
}

/**
 * Records one failed attempt and reports whether a threshold tripped.
 * The caller should reject the current request when this returns locked.
 */
export async function recordFailureAndMaybeLock(
  scope: string,
  identifier: string,
  deps: LockoutDeps = {},
  steps: readonly LockoutStep[] = LOCKOUT_STEPS
): Promise<LockoutStatus> {
  const check = deps.check ?? checkSharedRateLimit;
  const id = await hashId(scope, identifier);
  try {
    let worst: LockoutStep | null = null;
    for (const step of steps) {
      const r = await countFor(check, scope, id, step, step.failures);
      if (r && !r.allowed) {
        if (!worst || step.withinSeconds > worst.withinSeconds) worst = step;
      }
    }
    return worst ? { locked: true, step: worst } : { locked: false };
  } catch {
    return { locked: false };
  }
}
