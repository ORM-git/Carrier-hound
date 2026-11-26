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
import type { SalaryRational } from "@/lib/jobs/browseFilters";

export const SNAPSHOT_TTL_MS = 6 * 3600_000;
const READ_BATCH = 1000; // PostgREST max rows per request
/** Phase 0: largest prefiltered set 11,724 of a 29,604-row corpus. Above this the build FAILS loudly, never truncates. */
export const SNAPSHOT_MAX_ROWS = 100_000;

export interface FeedSnapshot {
  id: string;
  /** sha-256 of viewer + session epoch + tier + filters + scoring answers. */
  identity: string;
  jobIds: string[];
  /**
   * Best-effort staleness mark: newest first_seen_at INSIDE the frozen epoch this snapshot was ranked from (captured in
   * the same statement as the rows). It does not prove all-source changes: it ignores edits and backdated or tied inserts.
   */
  corpusMark: string | null;
  /** The frozen corpus epoch the rows came from, and when it was captured. rankedAt (= builtAt) can be up to the reuse window later. */
  epochId?: string;
  frozenAt?: string;
  /** Ranking/scoring time and the pinned date cutoff (rankedAt). */
  builtAt: number;
  expiresAt: number;
  /** Annual-salary filter HELD by this snapshot: the FX table and exact thresholds of the build are the ones every page uses. */
  salary?: HeldSalaryFilter | null;
}

/**
 * The salary filter a snapshot was built with. Thresholds are the #796 exact rationals computed ONCE at build from
 * `rates`; a continuation never recomputes them and never accepts client rates. A new cursorless request is the only
 * way to new rates (explicit reset).
 */
export interface HeldSalaryFilter {
  minAnnualSalary: number;
  currency: string;
  rates: Record<string, number>;
  fxSource: string;
  fxFetchedAt: string | null;
  thresholds: SalaryRational[];
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

/** Raised when the frozen corpus cannot be produced or read coherently. The route answers 503 snapshot_unavailable. */
export class SnapshotUnavailableError extends Error {}

/**
 * Coherent acquisition = a FROZEN relation. `public.feed_corpus_frozen` holds a copy of the visible active jobs made by
 * ONE `INSERT ... SELECT` inside `freeze_feed_corpus` (docs/proposed/feed_corpus_frozen.NOT_APPLIED.sql): one SQL
 * statement is one MVCC snapshot, so membership AND the column values ranking reads are coherent by construction.
 * The build then runs the unchanged applyRecommendedFilters builder over that immutable relation (`epoch = e`), so
 * filter logic has exactly one implementation. There is no fallback to live reads: a missing function, table or epoch is
 * an explicit failure, never a quietly weaker build.
 *
 * FROZEN_COLUMNS is the complete set of columns read by the request builder (every filter, the relevance prefilter, the
 * saved constraints), by ranking/capping/Free formatting (selectCols), and by the capture predicate. A test records the
 * columns actually referenced by the builder and fails if one is missing here; the proposed SQL is generated from this
 * list (a test compares them), so the two cannot drift.
 */
export const FROZEN_TABLE = "feed_corpus_frozen";
export const FROZEN_EPOCH_TABLE = "feed_corpus_epochs";
export const FROZEN_COLUMNS = [
  "id", "title", "company", "company_id", "company_slug", "location", "remote", "remote_scope", "remote_eligibility",
  "job_type", "salary_text", "salary_min", "salary_max", "salary_period", "currency", "first_seen_at", "posted_at",
  "created_at", "category", "country", "country_code", "description", "skills", "source_type", "source", "status", "is_active",
] as const;

/**
 * Placeholders, UNMEASURED: owner preview must set them. REUSE: viewers freezing within this window share one epoch
 * (bounds copy work). RETAIN: an epoch is purged only after this long; it must exceed the longest build, and a build
 * checks its epoch still exists after reading (see readFrozenCandidates), so a too-short value fails closed.
 */
export const FROZEN_REUSE_SECONDS = 60;
export const FROZEN_RETAIN_SECONDS = 3600;
/** Aggregate admission placeholders (UNMEASURED): total frozen rows and epoch count the SQL allows before it refuses a new copy. */
export const FROZEN_MAX_TOTAL_ROWS = 300_000;
export const FROZEN_MAX_EPOCHS = 10;

export interface FrozenEpoch { epoch: string; frozenAt: string; rowCount: number; corpusMark: string | null }

/**
 * One RPC: reuse a fresh epoch or take a new one-statement copy. Parameters are validated here AND in SQL (positive
 * integers, reuse <= retain). The caller's `maxRows` is enforced on a REUSED epoch too (the SQL does the same), so a
 * stricter bound never accepts an older oversize epoch. Over the bound the SQL raises 54000 and rolls back.
 */
export async function freezeCorpus(admin: any, maxRows: number = SNAPSHOT_MAX_ROWS, reuseSeconds: number = FROZEN_REUSE_SECONDS, retainSeconds: number = FROZEN_RETAIN_SECONDS, maxTotalRows: number = FROZEN_MAX_TOTAL_ROWS, maxEpochs: number = FROZEN_MAX_EPOCHS): Promise<FrozenEpoch> {
  const posInt = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 2_000_000_000;
  if (!posInt(maxRows) || !posInt(reuseSeconds) || !posInt(retainSeconds) || reuseSeconds > retainSeconds || !posInt(maxTotalRows) || maxTotalRows < maxRows || !posInt(maxEpochs) || maxEpochs > 100_000) throw new SnapshotUnavailableError("invalid freeze parameters");
  const { data, error } = await admin.rpc("freeze_feed_corpus", { p_reuse_seconds: reuseSeconds, p_retain_seconds: retainSeconds, p_max_rows: maxRows, p_max_total_rows: maxTotalRows, p_max_epochs: maxEpochs });
  if (error) {
    if (error.code === "54000" || /snapshot_too_large/.test(error.message || "")) throw new SnapshotTooLargeError(maxRows + 1);
    if (error.code === "53400" || /frozen_store_full/.test(error.message || "")) throw new SnapshotBusyError("frozen store is full; retry after purge");
    throw new SnapshotUnavailableError(`freeze_feed_corpus failed: ${error.message || "unknown"}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  const frozenMs = row ? Date.parse(String(row.out_frozen_at)) : NaN;
  const markOk = row && (row.out_corpus_mark == null || Number.isFinite(Date.parse(String(row.out_corpus_mark))));
  if (!row || !UUID_REGEX.test(String(row.out_epoch)) || !Number.isInteger(row.out_row_count) || row.out_row_count < 0 || !Number.isFinite(frozenMs) || !markOk) {
    throw new SnapshotUnavailableError("freeze_feed_corpus returned invalid metadata");
  }
  if (row.out_row_count > maxRows) throw new SnapshotTooLargeError(row.out_row_count);
  return { epoch: row.out_epoch, frozenAt: new Date(frozenMs).toISOString(), rowCount: row.out_row_count, corpusMark: row.out_corpus_mark ?? null };
}

/** Builder base over the frozen relation of one epoch (the capture already applied status/is_active/visible source). */
export function frozenCandidateQuery(admin: any, epoch: string, cols: string) {
  return admin.from(FROZEN_TABLE).select(cols).eq("epoch", epoch);
}

/**
 * Builder base over the frozen rows of one epoch that meet the exact salary thresholds: ONE call to
 * feed_frozen_salary_rows (docs/proposed/feed_salary_exact_rpc.NOT_APPLIED.sql), which validates the payload once and
 * joins the typed thresholds in the statement that reads the rows. Every other filter chains on it unchanged.
 */
export function frozenSalaryQuery(admin: any, epoch: string, cols: string, thresholds: SalaryRational[]) {
  return admin.rpc("feed_frozen_salary_rows", { p_epoch: epoch, p_thresholds: thresholds }).select(cols);
}

/** Serve-time source: the live rows among `ids` that still meet the snapshot's HELD thresholds (jobs_salary_rows). */
export function liveSalaryRows(admin: any, ids: string[], cols: string, thresholds: SalaryRational[]) {
  return admin.rpc("jobs_salary_rows", { p_ids: ids, p_thresholds: thresholds }).select(cols);
}

/**
 * Every candidate row of the query, by the immutable key `id` (id desc, `id < last`), de-duplicated by id. Over a frozen
 * epoch the relation cannot change, so the keyset is exact. `makeQuery` returns a fresh builder.
 * `batch` must be >= 1: an outer LIMIT 0 never runs a plpgsql set-returning body, so the salary RPC would skip its
 * payload validation (pinned by feedSalaryExactRpc.test.ts). Refused before any read.
 */
export async function readAllCandidates(makeQuery: () => any, batch: number = READ_BATCH): Promise<any[]> {
  if (!Number.isInteger(batch) || batch < 1) throw new SnapshotUnavailableError("candidate batch must be a positive integer");
  const byId = new Map<string, any>();
  let afterId: string | null = null;
  for (;;) {
    let q = makeQuery();
    if (afterId) q = q.lt("id", afterId);
    const { data, error } = await q.order("id", { ascending: false }).limit(batch);
    // Any read error, including 22023 (payload) and 22003 (numeric overflow) from the salary RPC, fails closed.
    if (error) throw new SnapshotUnavailableError(error.message || "candidate read failed");
    const rows: any[] = data || [];
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
    if (byId.size > SNAPSHOT_MAX_ROWS) throw new SnapshotTooLargeError(byId.size);
    if (rows.length < batch) return Array.from(byId.values());
    const last = rows[rows.length - 1];
    if (!UUID_REGEX.test(String(last.id))) throw new SnapshotUnavailableError("candidate id is not a UUID");
    afterId = last.id;
  }
}

/**
 * Read the filtered candidates of a frozen epoch, then confirm the epoch still exists. The purge deletes an epoch's
 * row and its frozen rows in ONE transaction, so an epoch row that is still present after the last batch was present
 * (with all its rows) for every earlier batch: the read saw the whole epoch. A purged epoch fails closed.
 */
export async function readFrozenCandidates(admin: any, epoch: string, makeQuery: () => any): Promise<any[]> {
  const rows = await readAllCandidates(makeQuery);
  const { data, error } = await admin.from(FROZEN_EPOCH_TABLE).select("epoch").eq("epoch", epoch).limit(1);
  if (error || !data || data.length !== 1) throw new SnapshotUnavailableError("frozen epoch was purged during the build");
  return rows;
}

/** The route's own ranking, over the complete candidate set: score order, relevance gate, global company cap. */
export function rankSnapshotIds(rows: any[], answers: OnboardingAnswers, personalized: boolean, scoredAt: number): string[] {
  const ranked = rankJobsByRecommendation(rows, personalized ? answers : null, scoredAt);
  const qualifying = personalized ? ranked.filter((j: any) => (j.matchScore ?? j._matchScore ?? 0) > 0) : ranked;
  return capJobsPerCompany(qualifying, 3, 30).map((j: any) => j.id);
}

/**
 * Serve-time hard eligibility, shared with the build: of the hydrated rows, the IDs that still pass the same
 * relevance and saved-country gate as ranking (rankJobsByRecommendation over `answers`, scored at the ORIGINAL build
 * time so no window slides). The frozen rank is untouched: the caller keeps snapshot order and only drops rows.
 */
export function stillEligibleIds(rows: any[], answers: OnboardingAnswers, personalized: boolean, builtAt: number): Set<string> {
  if (!personalized) return new Set(rows.map((r) => r.id));
  const ranked = rankJobsByRecommendation(rows, answers, builtAt);
  return new Set(ranked.filter((j: any) => (j.matchScore ?? j._matchScore ?? 0) > 0).map((j: any) => j.id));
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

/**
 * Budget of the per-isolate store, in stored job IDs across all snapshots: a COUNT bound, not a memory guarantee.
 * Real heap use (string and array overhead, ranking working memory, concurrent builds) is unmeasured, so no isolate
 * size claim is made; the owner preview must measure it. A snapshot is at most SNAPSHOT_MAX_ROWS (100k) IDs, so at
 * least five fit. Oldest snapshots are evicted first; a single snapshot over the budget is rejected.
 */
export const MEMORY_STORE_MAX_IDS = 500_000;
/** Entry-count budget too: empty or tiny snapshots cost per-entry overhead that an ID count never sees. Placeholder, unmeasured. */
export const MEMORY_STORE_MAX_SNAPSHOTS = 200;

/** Per-isolate store: tests and local prototype only (not shared across edge isolates, lost on recycle). */
export function memorySnapshotStore(maxIds: number = MEMORY_STORE_MAX_IDS, maxSnapshots: number = MEMORY_STORE_MAX_SNAPSHOTS): SnapshotStore & { size(): number } {
  const m = new Map<string, FeedSnapshot>();
  const total = () => { let n = 0; m.forEach((x) => { n += x.jobIds.length; }); return n; };
  return {
    async get(id) { return m.get(id) ?? null; },
    async put(s) {
      // A single snapshot over the whole budget is rejected, never kept past the bound.
      if (s.jobIds.length > maxIds) throw new SnapshotUnavailableError(`snapshot of ${s.jobIds.length} IDs exceeds the store budget of ${maxIds}`);
      m.delete(s.id); m.set(s.id, s);
      while (m.size > maxSnapshots) m.delete(m.keys().next().value as string);
      while (total() > maxIds) m.delete(m.keys().next().value as string); // insertion order: oldest first; the new one fits alone
    },
    async deleteExpired(now) { for (const [k, s] of Array.from(m)) if (s.expiresAt <= now) m.delete(k); },
    size: () => m.size,
  };
}

/** Prototype default store. Lives in the library, NOT in the route file: Next.js route modules may export only handlers and config. */
export const prototypeMemoryStore = memorySnapshotStore();

/** Raised when too many distinct builds are already running in this isolate; the route answers 503 snapshot_busy. */
export class SnapshotBusyError extends Error {}

/**
 * Concurrent cursorless builds for the SAME identity share one build. Distinct identities are bounded: past
 * MAX_INFLIGHT_BUILDS running builds a new one is refused (typed, retryable) instead of queueing unbounded work.
 * The slot is released in `finally`, so a failed build never leaks it. Placeholder bound, unmeasured (per isolate).
 */
export const MAX_INFLIGHT_BUILDS = 4;
const inflightBuilds = new Map<string, Promise<FeedSnapshot>>();
export function buildOnce(identity: string, build: () => Promise<FeedSnapshot>, maxInflight: number = MAX_INFLIGHT_BUILDS): Promise<FeedSnapshot> {
  const existing = inflightBuilds.get(identity);
  if (existing) return existing;
  if (inflightBuilds.size >= maxInflight) return Promise.reject(new SnapshotBusyError(`${inflightBuilds.size} builds already running`));
  const p = build().finally(() => inflightBuilds.delete(identity));
  inflightBuilds.set(identity, p);
  return p;
}

/** Durable store over public.feed_snapshots (proposed SQL in PR; NOT applied). Service-role client only. */
/** Durable admission placeholders (UNMEASURED): the owner sets them after measuring feed_snapshots size on a preview. */
export const DURABLE_MAX_SNAPSHOTS = 2_000;
export const DURABLE_MAX_TOTAL_IDS = 20_000_000;
export function supabaseSnapshotStore(admin: any): SnapshotStore {
  return {
    async get(id) {
      const { data, error } = await admin.from("feed_snapshots").select("id, identity, job_ids, corpus_mark, epoch_id, frozen_at, salary_filter, built_at, expires_at").eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data
        ? { id: data.id, identity: data.identity, jobIds: data.job_ids || [], corpusMark: data.corpus_mark, epochId: data.epoch_id ?? undefined, frozenAt: data.frozen_at ?? undefined, salary: data.salary_filter ?? null, builtAt: Date.parse(data.built_at), expiresAt: Date.parse(data.expires_at) }
        : null;
    },
    async put(s) {
      // Process-side mirror of the DB bound: refuse before sending a huge row.
      if (s.jobIds.length > SNAPSHOT_MAX_ROWS) throw new SnapshotUnavailableError(`snapshot of ${s.jobIds.length} IDs exceeds the durable bound of ${SNAPSHOT_MAX_ROWS}`);
      // One service-only RPC cleans expired rows and enforces the row-count and total-ID admission bound in one
      // transaction (docs/proposed/feed_snapshots_durable.NOT_APPLIED.sql). 53400 = store full: retryable busy, never an eviction.
      const { error } = await admin.rpc("put_feed_snapshot", {
        p_id: s.id, p_identity: s.identity, p_job_ids: s.jobIds, p_corpus_mark: s.corpusMark, p_epoch_id: s.epochId ?? null, p_frozen_at: s.frozenAt ?? null, p_salary_filter: s.salary ?? null,
        p_built_at: new Date(s.builtAt).toISOString(), p_expires_at: new Date(s.expiresAt).toISOString(),
        p_max_snapshots: DURABLE_MAX_SNAPSHOTS, p_max_total_ids: DURABLE_MAX_TOTAL_IDS,
      });
      if (error) {
        if (error.code === "53400" || /snapshot_store_full/.test(error.message || "")) throw new SnapshotBusyError("durable snapshot store is full; retry later");
        throw new Error(error.message);
      }
    },
    async deleteExpired(now) {
      const { error } = await admin.from("feed_snapshots").delete().lt("expires_at", new Date(now).toISOString());
      if (error) throw new Error(error.message);
    },
  };
}
