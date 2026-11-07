/**
 * Typed wrappers over the outbox RPCs from migrations 20261107c_outbox_queue.sql and
 * 20261107e_outbox_fencing.sql (both NOT APPLIED). Nothing in the repo calls these yet. Delivery is at-least-once,
 * so consumers must be idempotent. No numeric defaults: max attempts, lease
 * seconds and retry delay are always passed by the caller (owner to confirm).
 */
export type OutboxStatus = "pending" | "processing" | "done" | "dead";

export interface OutboxRow {
  id: string;
  topic: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: string;
  locked_until: string | null;
  locked_by: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: string;
  updated_at: string;
}

function positiveInt(name: string, v: unknown): number {
  if (typeof v !== "number" || !isFinite(v) || Math.floor(v) !== v || v <= 0) {
    throw new Error(`outbox: ${name} must be a positive integer`);
  }
  return v;
}

async function rpc(supabase: any, fn: string, args: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`outbox ${fn} failed: ${error.message || "unknown error"}`);
  return data;
}

export async function enqueueOutbox(
  supabase: any,
  input: { topic: string; payload: unknown; maxAttempts: number; dedupeKey?: string }
): Promise<string | null> {
  if (!input.topic) throw new Error("outbox: topic is required");
  const args: Record<string, unknown> = {
    p_topic: input.topic,
    p_payload: input.payload === undefined ? {} : input.payload,
    p_max_attempts: positiveInt("maxAttempts", input.maxAttempts),
  };
  if (input.dedupeKey !== undefined) args.p_dedupe_key = input.dedupeKey;
  const data = await rpc(supabase, "outbox_enqueue", args);
  return data ? String(data) : null;
}

export async function claimOutboxBatch(
  supabase: any,
  input: { topic: string; limit: number; leaseSeconds: number; worker: string }
): Promise<OutboxRow[]> {
  if (!input.topic) throw new Error("outbox: topic is required");
  if (!input.worker) throw new Error("outbox: worker is required");
  const data = await rpc(supabase, "outbox_claim_batch", {
    p_topic: input.topic,
    p_limit: positiveInt("limit", input.limit),
    p_lease_seconds: positiveInt("leaseSeconds", input.leaseSeconds),
    p_worker: input.worker,
  });
  return Array.isArray(data) ? (data as OutboxRow[]) : [];
}

function attemptToken(v: unknown): number {
  return positiveInt("attempt", v);
}

/**
 * attempt is the claimed row's `attempts` value (the fencing token): a completion
 * from an older claim of the same row, even by the same worker id, is refused.
 */
export async function ackOutbox(
  supabase: any,
  input: { id: string; worker: string; attempt: number }
): Promise<boolean> {
  const data = await rpc(supabase, "outbox_ack", {
    p_id: input.id,
    p_worker: input.worker,
    p_attempt: attemptToken(input.attempt),
  });
  return data === true;
}

export async function failOutbox(
  supabase: any,
  input: { id: string; worker: string; attempt: number; error: string; retryDelaySeconds: number }
): Promise<"retry" | "dead" | null> {
  const d = input.retryDelaySeconds;
  if (typeof d !== "number" || !isFinite(d) || Math.floor(d) !== d || d < 0) {
    throw new Error("outbox: retryDelaySeconds must be a non-negative integer");
  }
  const data = await rpc(supabase, "outbox_fail", {
    p_id: input.id,
    p_worker: input.worker,
    p_attempt: attemptToken(input.attempt),
    p_error: input.error,
    p_retry_delay_seconds: d,
  });
  return data === "retry" || data === "dead" ? data : null;
}
