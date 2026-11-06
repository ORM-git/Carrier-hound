/**
 * Deadlock retry handling for PostgREST RPC calls (audit DB #16).
 *
 * The billing, AI-budget, concurrency, rate-limit and fulfillment RPCs each
 * run as a single atomic Postgres statement. If Postgres aborts one with a
 * deadlock (SQLSTATE 40P01), the whole statement rolled back, so re-running
 * the same call once can never double-apply its effects. Without a retry a
 * rare deadlock surfaces as a failed payment or AI call.
 */

/** Postgres SQLSTATE for deadlock_detected. */
export const DEADLOCK_SQLSTATE = "40P01";

/**
 * Returns true when a PostgREST/Supabase error object reports a Postgres
 * deadlock. Checks the SQLSTATE code first, then the message/details text
 * (PostgREST may surface only the message for some error paths).
 */
export function isDeadlockError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string; details?: string };
  if (e.code === DEADLOCK_SQLSTATE) return true;
  const text = `${e.message ?? ""} ${e.details ?? ""}`.toLowerCase();
  return text.includes("deadlock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RpcRetryOptions {
  /** Extra attempts after the first call (default 1). */
  retries?: number;
  /** Base backoff in ms, multiplied by attempt number (default 50). */
  baseDelayMs?: number;
}

/**
 * Runs an RPC call and retries it when Postgres reports a deadlock.
 *
 * Usage: const { data, error } = await rpcWithRetry(() => client.rpc("fn", args));
 *
 * Only deadlock errors are retried; every other error (constraint violations,
 * permission errors, validation failures) is returned as-is on the first
 * attempt, so callers keep their existing error handling.
 */
export async function rpcWithRetry<F extends () => PromiseLike<{ error: unknown }>>(
  call: F,
  options?: RpcRetryOptions,
): Promise<Awaited<ReturnType<F>>> {
  const retries = options?.retries ?? 1;
  const baseDelayMs = options?.baseDelayMs ?? 50;
  let result = (await call()) as Awaited<ReturnType<F>>;
  let attempt = 0;
  while (attempt < retries && isDeadlockError(result.error)) {
    attempt += 1;
    // Small jittered backoff so two deadlocked callers do not collide again.
    await sleep(baseDelayMs * attempt + Math.floor(Math.random() * 25));
    result = (await call()) as Awaited<ReturnType<F>>;
  }
  return result;
}
