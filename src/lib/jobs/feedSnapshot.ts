/**
 * PROTOTYPE (flag FEED_SNAPSHOT_PROTOTYPE=on): a recommended feed ranked once over the WHOLE eligible corpus.
 *
 * Build: read every prefiltered candidate row (keyset, no pool cap), rank them with the unchanged
 * rankJobsByRecommendation + relevance gate + capJobsPerCompany in ONE pass, persist only the ordered job IDs.
 * Serve: walk the stored IDs by position; each page re-reads its rows at serve time (active, visible source,
 * entitlement-shaped columns). A stored ID whose job is gone is omitted and still consumes its position, so
 * nothing is duplicated and nothing removed comes back. Snapshots hold IDs + identity only, never job content.
 */
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { rankJobsByRecommendation, type OnboardingAnswers } from "@/lib/jobs/recommendations";
import { UUID_REGEX } from "@/lib/pagination/cursor";

export const SNAPSHOT_TTL_MS = 6 * 3600_000;
const READ_BATCH = 1000; // PostgREST max rows per request
/** Phase 0: largest prefiltered set 11,724 of a 29,604-row corpus. Above this the build FAILS loudly, never truncates. */
export const SNAPSHOT_MAX_ROWS = 100_000;

export interface FeedSnapshot {
  id: string;
  /** sha-256 of viewer + session epoch + tier + filters + scoring answers. */
  identity: string;
  jobIds: string[];
  /** Newest first_seen_at of active visible jobs when the build started: the staleness mark. */
  corpusMark: string | null;
  builtAt: number;
  expiresAt: number;
}

export interface SnapshotStore {
  get(id: string): Promise<FeedSnapshot | null>;
  put(snapshot: FeedSnapshot): Promise<void>;
  deleteExpired(now: number): Promise<void>;
}

export class SnapshotTooLargeError extends Error {
  constructor(readonly rows: number) {
    super(`snapshot candidate set exceeds ${SNAPSHOT_MAX_ROWS} rows`);
  }
}

export async function snapshotIdentity(parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const encodeSnapshotCursor = (id: string, position: number) => `fs1.${id}.${position}`;

export function decodeSnapshotCursor(raw: string | null | undefined): { id: string; position: number } | null {
  const m = /^fs1\.([0-9a-fA-F-]{36})\.(\d{1,9})$/.exec(raw || "");
  return m && UUID_REGEX.test(m[1]) ? { id: m[1], position: Number(m[2]) } : null;
}

/** Every candidate row of the query, newest first, by (posted_at, id) keyset. `makeQuery` returns a fresh builder. */
export async function readAllCandidates(makeQuery: () => any): Promise<any[]> {
  const rows: any[] = [];
  let after: { posted_at: string | null; id: string } | null = null;
  for (;;) {
    let q = makeQuery();
    if (after) {
      q = after.posted_at
        ? q.or(`posted_at.lt.${after.posted_at},and(posted_at.eq.${after.posted_at},id.lt.${after.id}),posted_at.is.null`)
        : q.is("posted_at", null).lt("id", after.id);
    }
    const { data, error } = await q.order("posted_at", { ascending: false, nullsFirst: false }).order("id", { ascending: false }).limit(READ_BATCH);
    if (error) throw new Error(error.message || "candidate read failed");
    const batch: any[] = data || [];
    rows.push(...batch);
    if (rows.length > SNAPSHOT_MAX_ROWS) throw new SnapshotTooLargeError(rows.length);
    if (batch.length < READ_BATCH) return rows;
    const last = batch[batch.length - 1];
    // Keys come from the database, but they still go into a filter: only a UUID id may.
    if (!UUID_REGEX.test(String(last.id))) throw new Error("candidate id is not a UUID");
    after = { posted_at: last.posted_at ?? null, id: last.id };
  }
}

/** The route's own ranking, over the complete candidate set: score order, relevance gate, global company cap. */
export function rankSnapshotIds(rows: any[], answers: OnboardingAnswers, personalized: boolean, scoredAt: number): string[] {
  const ranked = rankJobsByRecommendation(rows, personalized ? answers : null, scoredAt);
  const qualifying = personalized ? ranked.filter((j: any) => (j.matchScore ?? j._matchScore ?? 0) > 0) : ranked;
  return capJobsPerCompany(qualifying, 3, 30).map((j: any) => j.id);
}

/**
 * Next page from `position`: hydrate the following IDs at serve time, in snapshot order. Missing rows (deleted,
 * inactive, hidden, not entitled) are omitted but consumed. Bounded rounds: a page of mostly-removed jobs comes
 * back short with a cursor rather than scanning the whole snapshot in one request.
 */
export async function serveSnapshotPage(
  snapshot: FeedSnapshot,
  position: number,
  pageSize: number,
  hydrate: (ids: string[]) => Promise<any[]>,
  maxRounds = 4
): Promise<{ rows: any[]; position: number; done: boolean }> {
  const rows: any[] = [];
  for (let round = 0; round < maxRounds && rows.length < pageSize && position < snapshot.jobIds.length; round++) {
    const ids = snapshot.jobIds.slice(position, position + pageSize - rows.length);
    const byId = new Map((await hydrate(ids)).map((r) => [r.id, r]));
    for (const id of ids) if (byId.has(id)) rows.push(byId.get(id));
    position += ids.length;
  }
  return { rows, position, done: position >= snapshot.jobIds.length };
}

/** Per-isolate store: tests and local prototype only (not shared across edge isolates, lost on recycle). */
export function memorySnapshotStore(): SnapshotStore & { size(): number } {
  const m = new Map<string, FeedSnapshot>();
  return {
    async get(id) { return m.get(id) ?? null; },
    async put(s) { m.set(s.id, s); },
    async deleteExpired(now) { for (const [k, s] of Array.from(m)) if (s.expiresAt <= now) m.delete(k); },
    size: () => m.size,
  };
}

/** Durable store over public.feed_snapshots (proposed SQL in PR; NOT applied). Service-role client only. */
export function supabaseSnapshotStore(admin: any): SnapshotStore {
  return {
    async get(id) {
      const { data, error } = await admin.from("feed_snapshots").select("id, identity, job_ids, corpus_mark, built_at, expires_at").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data
        ? { id: data.id, identity: data.identity, jobIds: data.job_ids || [], corpusMark: data.corpus_mark, builtAt: Date.parse(data.built_at), expiresAt: Date.parse(data.expires_at) }
        : null;
    },
    async put(s) {
      const { error } = await admin.from("feed_snapshots").insert({
        id: s.id, identity: s.identity, job_ids: s.jobIds, corpus_mark: s.corpusMark,
        built_at: new Date(s.builtAt).toISOString(), expires_at: new Date(s.expiresAt).toISOString(),
      });
      if (error) throw new Error(error.message);
    },
    async deleteExpired(now) {
      const { error } = await admin.from("feed_snapshots").delete().lt("expires_at", new Date(now).toISOString());
      if (error) throw new Error(error.message);
    },
  };
}
