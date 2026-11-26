/**
 * PROTOTYPE (flag-gated, see /api/jobs/ranked-feed): full-corpus server-ranked feed snapshots.
 *
 * - Build: read EVERY eligible row (keyset by id, no pool cap), rank once with the unchanged
 *   rankJobsByRecommendation + capJobsPerCompany pipeline of /api/jobs/recommended, store the ordered ids.
 * - Serve: walk stored ids by position; every page re-checks eligibility and entitlement at serve time.
 *   A stored id that is no longer eligible is OMITTED (consumes its position, never resurrected).
 * - Identity: viewer + session epoch + filters + tier. A cursor from another identity resets.
 *   A newer ingest epoch marks the snapshot stale: issued cursors keep walking it (consistent pages);
 *   the next cursor-less request (natural reset) builds a fresh one.
 * Snapshots hold job ids and rank keys only, never job content.
 */
import { rankJobsByRecommendation, type OnboardingAnswers } from "@/lib/jobs/recommendations";
import { capJobsPerCompany } from "@/lib/jobs/capping";

export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
export const CORPUS_BATCH = 1000; // PostgREST default max-rows
/** Measured bound for an interactive build (PR body, Phase 0). Exceeding it is an explicit error, never a truncation. */
export const MAX_INTERACTIVE_BUILD_ROWS = 20000;
export const CURSOR_PREFIX = "rf1.";

export interface RankedSnapshot {
  id: string;
  identity: string;
  ingestEpoch: string | null;
  builtAt: number;
  expiresAt: number;
  jobIds: string[];
  scores: number[];
  eligibleRows: number;
}

export interface SnapshotStore {
  get(id: string): Promise<RankedSnapshot | null>;
  latestForIdentity(identity: string): Promise<RankedSnapshot | null>;
  put(s: RankedSnapshot): Promise<void>;
  deleteExpired(now: number): Promise<number>;
}

/** shortcut: process-local store; edge isolates do not share it. Replace with the proposed feed_snapshots table before activation. */
export class MemorySnapshotStore implements SnapshotStore {
  private byId = new Map<string, RankedSnapshot>();
  async get(id: string) { return this.byId.get(id) ?? null; }
  async latestForIdentity(identity: string) {
    let best: RankedSnapshot | null = null;
    for (const s of Array.from(this.byId.values())) if (s.identity === identity && (!best || s.builtAt > best.builtAt)) best = s;
    return best;
  }
  async put(s: RankedSnapshot) { this.byId.set(s.id, s); }
  async deleteExpired(now: number) {
    let n = 0;
    for (const [id, s] of Array.from(this.byId)) if (s.expiresAt <= now) { this.byId.delete(id); n++; }
    return n;
  }
  get size() { return this.byId.size; }
}

export class SnapshotTooLargeError extends Error {
  constructor(public scannedRows: number, public bound: number) {
    super(`eligible corpus exceeds the interactive build bound (${scannedRows} > ${bound})`);
  }
}

/** SHA-256 over the identity inputs (order-fixed). Not a secret: a fail-closed consistency key. */
export async function snapshotIdentity(parts: {
  viewerKey: string;
  sessionEpoch: string | null;
  filterIdentity: string;
  tier: "pro" | "free";
  answersIdentity: string;
}): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([parts.viewerKey, parts.sessionEpoch, parts.filterIdentity, parts.tier, parts.answersIdentity]));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads every eligible row. `page(afterId)` must apply the eligibility filters and return rows ordered by id desc. */
export async function loadFullCorpus<T extends { id: string }>(
  page: (afterId: string | null, limit: number) => Promise<T[]>,
  bound: number = MAX_INTERACTIVE_BUILD_ROWS
): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (;;) {
    const rows = await page(after, CORPUS_BATCH);
    out.push(...rows);
    if (out.length > bound) throw new SnapshotTooLargeError(out.length, bound);
    if (rows.length < CORPUS_BATCH) return out;
    after = rows[rows.length - 1].id;
  }
}

/** The /api/jobs/recommended ranking pipeline, unchanged, over the complete input. */
export function rankFullCorpus<T extends { id: string }>(rows: T[], answers: OnboardingAnswers | null, personalized: boolean, builtAt: number) {
  const ranked = rankJobsByRecommendation(rows as any[], answers, builtAt);
  const qualifying = personalized ? ranked.filter((j) => (j.matchScore ?? j._matchScore ?? 0) > 0) : ranked;
  const capped = capJobsPerCompany(qualifying, 3, 30);
  return { jobIds: capped.map((j) => String(j.id)), scores: capped.map((j) => Number(j.matchScore ?? j._matchScore ?? 0)) };
}

export function encodeSnapshotCursor(snapshotId: string, position: number): string {
  return `${CURSOR_PREFIX}${snapshotId}.${position}`;
}

export function decodeSnapshotCursor(raw?: string | null): { snapshotId: string; position: number } | null {
  if (!raw || !raw.startsWith(CURSOR_PREFIX)) return null;
  const m = raw.slice(CURSOR_PREFIX.length).match(/^([0-9a-f-]{36})\.(\d{1,7})$/);
  return m ? { snapshotId: m[1], position: Number(m[2]) } : null;
}

export interface ServedPage<R> {
  rows: R[];
  nextPosition: number;
  omitted: number;
  hasNextPage: boolean;
}

/**
 * Fills one page from `position`. `loadValid(ids)` returns the rows that are eligible and entitled NOW
 * (any subset). Ids it does not return are omitted and their positions consumed. Bounded work per request:
 * a short page with hasNextPage=true is returned rather than scanning the whole snapshot in one call.
 */
export async function servePage<R extends { id: string }>(
  snapshot: Pick<RankedSnapshot, "jobIds">,
  position: number,
  pageSize: number,
  loadValid: (ids: string[]) => Promise<R[]>,
  maxChunks = 5
): Promise<ServedPage<R>> {
  const rows: R[] = [];
  let pos = Math.max(0, Math.min(position, snapshot.jobIds.length));
  let omitted = 0;
  const chunkSize = Math.max(pageSize * 2, 10);
  for (let c = 0; c < maxChunks && rows.length < pageSize && pos < snapshot.jobIds.length; c++) {
    const chunk = snapshot.jobIds.slice(pos, pos + chunkSize);
    const valid = new Map((await loadValid(chunk)).map((r) => [String(r.id), r]));
    for (const id of chunk) {
      if (rows.length >= pageSize) break;
      pos++;
      const row = valid.get(id);
      if (row) rows.push(row);
      else omitted++;
    }
  }
  return { rows, nextPosition: pos, omitted, hasNextPage: pos < snapshot.jobIds.length };
}

export type ResolveResult =
  | { kind: "serve"; snapshot: RankedSnapshot; position: number; stale: boolean; built: boolean }
  | { kind: "cursor_reset" };

/**
 * Picks the snapshot for a request. With a cursor: it must name a live snapshot of THIS identity, else reset
 * (filter/tier/session change). Without one: reuse the newest unexpired, non-stale snapshot, otherwise build.
 */
export async function resolveSnapshot(args: {
  store: SnapshotStore;
  identity: string;
  cursor: string | null;
  ingestEpoch: string | null;
  now: number;
  build: (builtAt: number) => Promise<{ jobIds: string[]; scores: number[]; eligibleRows: number }>;
}): Promise<ResolveResult> {
  const { store, identity, cursor, ingestEpoch, now } = args;
  await store.deleteExpired(now);
  if (cursor) {
    const c = decodeSnapshotCursor(cursor);
    const s = c ? await store.get(c.snapshotId) : null;
    if (!c || !s || s.identity !== identity || s.expiresAt <= now || c.position > s.jobIds.length) return { kind: "cursor_reset" };
    return { kind: "serve", snapshot: s, position: c.position, stale: s.ingestEpoch !== ingestEpoch, built: false };
  }
  const existing = await store.latestForIdentity(identity);
  if (existing && existing.expiresAt > now && existing.ingestEpoch === ingestEpoch) {
    return { kind: "serve", snapshot: existing, position: 0, stale: false, built: false };
  }
  const built = await args.build(now);
  const snapshot: RankedSnapshot = { id: crypto.randomUUID(), identity, ingestEpoch, builtAt: now, expiresAt: now + SNAPSHOT_TTL_MS, ...built };
  await store.put(snapshot);
  return { kind: "serve", snapshot, position: 0, stale: false, built: true };
}

/** The prototype route's store (see MemorySnapshotStore shortcut). */
export const prototypeSnapshotStore = new MemorySnapshotStore();
