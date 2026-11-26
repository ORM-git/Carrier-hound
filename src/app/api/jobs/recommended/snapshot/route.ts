import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { getClientIpFromRequest, checkRateLimit, getRuntimeEnv } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { createLogger } from "@/lib/observability/logger";
import { applyRecommendedFilters, baseCandidateQuery, formatRecommendedJobs, resolveRecommendedRequest } from "@/lib/jobs/recommendedRequest";
import {
  decodeSnapshotCursor, encodeSnapshotCursor, memorySnapshotStore, rankSnapshotIds, readAllCandidates, serveSnapshotPage,
  snapshotIdentity, SnapshotTooLargeError, supabaseSnapshotStore, SNAPSHOT_TTL_MS, type FeedSnapshot,
} from "@/lib/jobs/feedSnapshot";

const log = createLogger({ context: { route: "/api/jobs/recommended/snapshot" } });

export const runtime = "edge";

/** Prototype default store; FEED_SNAPSHOT_STORE=table uses public.feed_snapshots once the owner applies its SQL. */
export const prototypeMemoryStore = memorySnapshotStore();
const PRO_EXTRA_COLS = ["apply_url", "description", "skills", "logo_url", "companies(logo_url, domain)"];
const NON_FILTER_PARAMS = new Set(["page", "pageSize", "cursor"]);

/**
 * GET /api/jobs/recommended/snapshot (PROTOTYPE, flag-gated, no live consumer)
 * No cursor: build a snapshot of the full eligible corpus and serve page 1. `cursor=fs1.<id>.<position>`: serve the
 * next page of that snapshot, only for the same viewer, session epoch, tier and filters (otherwise 409 reset).
 */
export async function GET(req: Request) {
  const respond = (body: any, status = 200) => NextResponse.json(body, { status });
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
      if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded. Please try again shortly.", retryAfter: limit.retryAfter }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
    }

    const { searchParams } = new URL(req.url);
    const rawPageSize = parseInt(searchParams.get("pageSize") || "25", 10);
    const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, Math.floor(rawPageSize)) : 25;
    const r = await resolveRecommendedRequest(req, searchParams, cfEnv, log);
    const store = getRuntimeEnv("FEED_SNAPSHOT_STORE", cfEnv) === "table" ? supabaseSnapshotStore(r.supabaseAdmin) : prototypeMemoryStore;
    const filters = Array.from(searchParams.entries()).filter(([k]) => !NON_FILTER_PARAMS.has(k)).sort();
    const identity = await snapshotIdentity([r.userId, r.sessionEpoch, r.isPro, r.targetTable, filters, r.answers]);

    // Staleness mark: the newest insert across ALL sources (first_seen_at defaults to now() on insert).
    const mark = await baseCandidateQuery(r, "first_seen_at").order("first_seen_at", { ascending: false }).limit(1);
    if (mark.error) return respond({ error: "Database service unavailable", jobs: [], totalCount: 0 }, 503);
    const corpusMark: string | null = mark.data?.[0]?.first_seen_at ?? null;

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
      const rows = await readAllCandidates(() => applyRecommendedFilters(baseCandidateQuery(r, r.selectCols), searchParams, r.answers, r.hasServiceKey));
      snapshot = {
        id: crypto.randomUUID(), identity, corpusMark, builtAt: now, expiresAt: now + SNAPSHOT_TTL_MS,
        jobIds: rankSnapshotIds(rows, r.answers, r.isPersonalized || r.hasResume, now),
      };
      await store.deleteExpired(now);
      await store.put(snapshot);
    }

    // Serve-time eligibility and entitlement: Free reads the narrow card columns only; Pro adds its columns.
    const cols = r.isPro && r.hasServiceKey ? Array.from(new Set([...r.selectCols.split(", "), ...PRO_EXTRA_COLS])).join(", ") : r.selectCols;
    const page = await serveSnapshotPage(snapshot, position, pageSize, async (ids) => {
      const { data, error } = await baseCandidateQuery(r, cols).in("id", ids);
      if (error) throw new Error(error.message || "hydrate failed");
      return data || [];
    });
    let jobs: any[];
    try {
      jobs = await formatRecommendedJobs(page.rows, { isPro: r.isPro, hasServiceKey: r.hasServiceKey, cfEnv, displayAnswers: r.displayAnswers, isPersonalized: r.isPersonalized, answers: r.answers, scoredAt: snapshot.builtAt });
    } catch (e: any) {
      log.error("Company group secret unavailable; refusing non-Pro snapshot page", { error: e?.message || e });
      return respond({ error: "Database service unavailable", jobs: [], totalCount: 0 }, 503);
    }
    return respond({
      jobs,
      totalCount: snapshot.jobIds.length, // exact eligible count at build
      hasNextPage: !page.done,
      nextCursor: page.done ? null : encodeSnapshotCursor(snapshot.id, page.position),
      // Newer jobs exist than this snapshot holds: pages stay consistent; a cursor-less request rebuilds.
      stale: Boolean(corpusMark && (!snapshot.corpusMark || corpusMark > snapshot.corpusMark)),
      snapshotBuiltAt: new Date(snapshot.builtAt).toISOString(),
      personalized: r.isPersonalized || r.hasResume,
      isPro: r.isPro,
    });
  } catch (err: any) {
    if (err instanceof SnapshotTooLargeError) {
      log.error("Snapshot candidate set over the hard bound; refusing to truncate", { rows: err.rows });
      return respond({ error: "snapshot_too_large", jobs: [], totalCount: 0 }, 503);
    }
    log.error("Unhandled error in /api/jobs/recommended/snapshot", { error: err?.message || err });
    return respond({ error: "Failed to build recommended snapshot", jobs: [], totalCount: 0 }, 503);
  }
}
