import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { getClientIpFromRequest, checkRateLimit, getRuntimeEnv } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { createLogger } from "@/lib/observability/logger";
import { applyRecommendedFilters, baseCandidateQuery, formatRecommendedJobs, resolveRecommendedRequest } from "@/lib/jobs/recommendedRequest";
import {
  buildOnce, decodeSnapshotCursor, freezeCorpus, frozenCandidateQuery, readFrozenCandidates, SnapshotBusyError, SnapshotUnavailableError, encodeSnapshotCursor, prototypeMemoryStore, rankSnapshotIds, serveSnapshotPage,
  snapshotIdentity, stillEligibleIds, SnapshotTooLargeError, supabaseSnapshotStore, SNAPSHOT_TTL_MS, type FeedSnapshot,
} from "@/lib/jobs/feedSnapshot";

const log = createLogger({ context: { route: "/api/jobs/recommended/snapshot" } });

export const runtime = "edge";

// Prototype default store (prototypeMemoryStore) lives in the library: a Next.js route module may export only handlers
// and fixed config. FEED_SNAPSHOT_STORE=table uses public.feed_snapshots once the owner applies its SQL.
const PRO_EXTRA_COLS = ["apply_url", "description", "skills", "logo_url", "companies(logo_url, domain)"];
const NON_FILTER_PARAMS = new Set(["page", "pageSize", "cursor"]);

/**
 * GET /api/jobs/recommended/snapshot (PROTOTYPE, flag-gated, no live consumer)
 * No cursor: build a snapshot of the full eligible corpus and serve page 1. `cursor=fs1.<id>.<position>`: serve the
 * next page of that snapshot, only for the same viewer, session epoch, tier and filters (otherwise 409 reset).
 */
export async function GET(req: Request) {
  // Per-viewer, session-bound data: never cacheable by a shared cache or the browser.
  const respond = (body: any, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  let cfEnv: Record<string, any> | undefined;
  try {
    cfEnv = getRequestContext()?.env as Record<string, any> | undefined;
  } catch {}
  if (getRuntimeEnv("FEED_SNAPSHOT_PROTOTYPE", cfEnv) !== "on") return respond({ error: "Not found" }, 404);

  try {
    if (!(process.env.NODE_ENV === "test" && process.env.__CAREERMONKE_LEGACY_RATE_LIMIT === "true")) {
      const ip = getClientIpFromRequest(req);
      const limit = await checkSharedRateLimit(`recommended:ip:${ip}`, SEARCH_RATE_LIMIT.maxRequests, SEARCH_RATE_LIMIT.windowSeconds, () =>
        checkRateLimit(ip, searchRateLimitStore, SEARCH_RATE_LIMIT.maxRequests, SEARCH_RATE_LIMIT.windowSeconds * 1000));
      if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded. Please try again shortly.", retryAfter: limit.retryAfter }, { status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "private, no-store" } });
    }

    const { searchParams } = new URL(req.url);
    const rawPageSize = parseInt(searchParams.get("pageSize") || "25", 10);
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, Math.floor(rawPageSize)) : 25;
    const r = await resolveRecommendedRequest(req, searchParams, cfEnv, log);
    // The coherent build reads a frozen relation that only the service role can create and read. Without the service key
    // (jobs_public path) there is none: fail closed, never a weaker live read.
    if (!r.hasServiceKey) return respond({ error: "snapshot_unavailable", jobs: [], totalCount: 0 }, 503);
    const store = getRuntimeEnv("FEED_SNAPSHOT_STORE", cfEnv) === "table" ? supabaseSnapshotStore(r.supabaseAdmin) : prototypeMemoryStore;
    const filters = Array.from(searchParams.entries()).filter(([k]) => !NON_FILTER_PARAMS.has(k)).sort();
    const identity = await snapshotIdentity([r.userId, r.sessionEpoch, r.isPro, r.targetTable, filters, r.answers]);

    const now = Date.now();
    const rawCursor = searchParams.get("cursor");
    let snapshot: FeedSnapshot | null = null;
    let position = 0;
    if (rawCursor) {
      const c = decodeSnapshotCursor(rawCursor);
      snapshot = c ? await store.get(c.id) : null;
      // Another viewer's, session's, tier's or filter set's snapshot, an expired one, or a bad cursor: rebuild at page 1.
      if (!c || !snapshot || snapshot.identity !== identity || snapshot.expiresAt <= now) {
        return respond({ error: "snapshot_reset", jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null }, 409);
      }
      position = c.position;
    } else {
      if (!applyRecommendedFilters(baseCandidateQuery(r, "id"), searchParams, r.answers, r.hasServiceKey)) {
        return respond({ error: "Company preferences unavailable", jobs: [], totalCount: 0 }, 503);
      }
      // Concurrent identical cursorless builds (same viewer, session, tier, filters, answers) share ONE build.
      snapshot = await buildOnce(identity, async () => {
        const frozen = await freezeCorpus(r.supabaseAdmin);
        const rows = await readFrozenCandidates(r.supabaseAdmin, frozen.epoch, () =>
          applyRecommendedFilters(frozenCandidateQuery(r.supabaseAdmin, frozen.epoch, r.selectCols), searchParams, r.answers, true, now));
        const built: FeedSnapshot = {
          id: crypto.randomUUID(), identity, corpusMark: frozen.corpusMark, epochId: frozen.epoch, frozenAt: frozen.frozenAt, builtAt: now, expiresAt: now + SNAPSHOT_TTL_MS,
          jobIds: rankSnapshotIds(rows, r.answers, r.isPersonalized || r.hasResume, now),
        };
        await store.deleteExpired(now);
        await store.put(built);
        return built;
      });
    }

    // Serve-time eligibility and entitlement: Free reads the narrow card columns only; Pro adds its columns.
    const cols = r.isPro && r.hasServiceKey ? Array.from(new Set([...r.selectCols.split(", "), ...PRO_EXTRA_COLS])).join(", ") : r.selectCols;
    const builtAt = snapshot.builtAt;
    const personalized = r.isPersonalized || r.hasResume;
    const page = await serveSnapshotPage(snapshot, position, pageSize, async (ids) => {
      // Frozen RANK, live hard ELIGIBILITY: the stored order stays, but every explicit filter, the saved-country and
      // relevance gate and the relevance prefilter are re-applied to the current row, with the date cutoff and
      // scoring time pinned to the ORIGINAL build time (builtAt), so a window never slides.
      const q = applyRecommendedFilters(baseCandidateQuery(r, cols), searchParams, r.answers, r.hasServiceKey, builtAt);
      if (!q) throw new Error("company preferences unavailable");
      const { data, error } = await q.in("id", ids);
      if (error) throw new Error(error.message || "hydrate failed");
      const rows: any[] = data || [];
      const ok = stillEligibleIds(rows, r.answers, personalized, builtAt);
      return rows.filter((row) => ok.has(row.id));
    });
    let jobs: any[];
    try {
      jobs = await formatRecommendedJobs(page.rows, { isPro: r.isPro, hasServiceKey: r.hasServiceKey, cfEnv, displayAnswers: r.displayAnswers, isPersonalized: r.isPersonalized, answers: r.answers, scoredAt: snapshot.builtAt });
    } catch (e: any) {
      log.error("Company group secret unavailable; refusing non-Pro snapshot page", { error: e?.message || e });
      return respond({ error: "Database service unavailable", jobs: [], totalCount: 0 }, 503);
    }
    // Best-effort staleness: the live newest insert (all visible sources) versus the newest insert INSIDE this snapshot's
    // epoch. Not an exhaustive ingest signal: it ignores edits and can miss backdated or tied inserts.
    const mark = await baseCandidateQuery(r, "first_seen_at").order("first_seen_at", { ascending: false }).limit(1);
    if (mark.error) return respond({ error: "Database service unavailable", jobs: [], totalCount: 0 }, 503);
    const liveMark: string | null = mark.data?.[0]?.first_seen_at ?? null;
    return respond({
      jobs,
      totalCount: snapshot.jobIds.length, // exact eligible count at build
      hasNextPage: !page.done,
      nextCursor: page.done ? null : encodeSnapshotCursor(snapshot.id, page.position),
      // Newer jobs exist than this snapshot holds: pages stay consistent; a cursor-less request rebuilds.
      stale: Boolean(liveMark && (!snapshot.corpusMark || liveMark > snapshot.corpusMark)),
      snapshotBuiltAt: new Date(snapshot.builtAt).toISOString(), // ranking time (rankedAt)
      corpusCapturedAt: snapshot.frozenAt ?? null, // when the epoch rows were captured (up to the reuse window earlier)
      personalized: r.isPersonalized || r.hasResume,
      isPro: r.isPro,
    });
  } catch (err: any) {
    if (err instanceof SnapshotBusyError) {
      return NextResponse.json({ error: "snapshot_busy", jobs: [], totalCount: 0 }, { status: 503, headers: { "Retry-After": "5", "Cache-Control": "private, no-store" } });
    }
    if (err instanceof SnapshotUnavailableError) {
      log.error("Frozen corpus unavailable; refusing to build", { error: err.message });
      return respond({ error: "snapshot_unavailable", jobs: [], totalCount: 0 }, 503);
    }
    if (err instanceof SnapshotTooLargeError) {
      log.error("Snapshot candidate set over the hard bound; refusing to truncate", { rows: err.rows });
      return respond({ error: "snapshot_too_large", jobs: [], totalCount: 0 }, 503);
    }
    log.error("Unhandled error in /api/jobs/recommended/snapshot", { error: err?.message || err });
    return respond({ error: "Failed to build recommended snapshot", jobs: [], totalCount: 0 }, 503);
  }
}
