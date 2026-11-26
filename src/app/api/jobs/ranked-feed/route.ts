/**
 * GET /api/jobs/ranked-feed: PROTOTYPE, OFF unless RANKED_FEED_PROTOTYPE=true (404 otherwise).
 * Live traffic does not call this route. Full-corpus server-ranked snapshots: see src/lib/jobs/rankedSnapshot.ts.
 *
 * Params: cursor (rf1.<snapshot>.<position>), pageSize, and the supported hard filters jobType, workModel,
 * level, datePosted, excludeTitle / includeCompany / excludeCompany (repeated). Any other param is a 400:
 * the prototype never silently ignores a filter it does not evaluate.
 */
import { NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";
import { getSupabaseAdminClient, getRuntimeEnv, getClientIpFromRequest, checkRateLimit } from "@/lib/ai/serviceHandler";
import { checkSharedRateLimit, SEARCH_RATE_LIMIT, searchRateLimitStore } from "@/lib/api/sharedRateLimit";
import { getServerEntitlement } from "@/lib/billing/serverEntitlement";
import { loadDisplayScoreAnswers } from "@/lib/jobs/displayScore";
import { buildRelevancePrefilter, hasOnboardingAnswers, hasResumeSignals, type OnboardingAnswers } from "@/lib/jobs/recommendations";
import { isOnboardingStep2EnabledServer } from "@/config/onboarding";
import { loadResumeProfileForRanking } from "@/lib/onboarding/resumeParse";
import { applyExperienceLevelQuery, formatExperienceLevels, parseExperienceLevels } from "@/lib/jobs/experienceLevels";
import { filterTokens, jobTypeOrClause, workModelOrClause } from "@/lib/jobs/jobFilters";
import { applyFeedConstraints, datePostedCutoff, feedConstraintsFromParams, parseDatePosted } from "@/lib/preferences/feedConstraints";
import { VISIBLE_SOURCE_FILTER } from "@/lib/jobs/sourcePolicy";
import { buildCompanyGroupIdMap, COMPANY_GROUP_SECRET_ENV } from "@/lib/jobs/capping";
import { answersFromPreferencesRow, formatRecommendedRow, PREFERENCE_ANSWER_COLUMNS } from "@/lib/jobs/recommendedShared";
import {
  loadFullCorpus,
  prototypeSnapshotStore,
  rankFullCorpus,
  resolveSnapshot,
  servePage,
  snapshotIdentity,
  SnapshotTooLargeError,
  encodeSnapshotCursor,
} from "@/lib/jobs/rankedSnapshot";

export const runtime = "edge";

// Per-viewer snapshot pages: never cacheable by any shared cache.
const json = (body: unknown, init?: ResponseInit) => {
  const res = NextResponse.json(body, init);
  res.headers.set("Cache-Control", "private, no-store");
  return res;
};

const SUPPORTED = new Set(["cursor", "pageSize", "jobType", "workModel", "level", "datePosted", "excludeTitle", "includeCompany", "excludeCompany"]);
// Same candidate columns as /api/jobs/recommended; Pro-only payload is hydrated at serve time only.
const BASE_COLS = "id, title, company, company_id, location, remote, remote_scope, remote_eligibility, job_type, salary_text, salary_min, salary_max, salary_period, currency, first_seen_at, posted_at, created_at, category, country, country_code";
const PRO_COLS = ", apply_url, description, skills, logo_url, companies(logo_url, domain)"; // = PRO_HYDRATE_COLS

export async function GET(req: Request) {
  let cfEnv: Record<string, any> | undefined;
  try {
    cfEnv = getRequestContext()?.env as Record<string, any> | undefined;
  } catch {}
  if (getRuntimeEnv("RANKED_FEED_PROTOTYPE", cfEnv) !== "true") return json({ error: "Not found" }, { status: 404 });

  const clientIp = getClientIpFromRequest(req);
  const limit = await checkSharedRateLimit(`ranked-feed:ip:${clientIp}`, SEARCH_RATE_LIMIT.maxRequests, SEARCH_RATE_LIMIT.windowSeconds, () =>
    checkRateLimit(clientIp, searchRateLimitStore, SEARCH_RATE_LIMIT.maxRequests, SEARCH_RATE_LIMIT.windowSeconds * 1000)
  );
  if (!limit.allowed) {
    return json({ error: "Rate limit exceeded. Please try again shortly.", retryAfter: limit.retryAfter }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }

  const { searchParams } = new URL(req.url);
  for (const key of Array.from(searchParams.keys())) {
    if (!SUPPORTED.has(key)) return json({ error: "unsupported_on_prototype", param: key }, { status: 400 });
  }
  const rawPageSize = parseInt(searchParams.get("pageSize") || "25", 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1 ? Math.min(100, Math.floor(rawPageSize)) : 25;

  // Full corpus needs the jobs table (company/company_id for capping): no jobs_public fallback.
  const hasServiceKey = Boolean(getRuntimeEnv("SUPABASE_SERVICE_ROLE_KEY", cfEnv) || getRuntimeEnv("SUPABASE_SERVICE_KEY", cfEnv));
  if (!hasServiceKey) return json({ error: "Ranked feed unavailable", jobs: [] }, { status: 503 });
  const db = getSupabaseAdminClient(cfEnv, true);

  // Viewer, tier and answers, exactly as /api/jobs/recommended derives them for a signed-in user.
  let isPro = false;
  let viewerKey = "guest";
  let sessionEpoch: string | null = null;
  let answers: OnboardingAnswers = {};
  let displayAnswers: OnboardingAnswers | null = null;
  const auth = req.headers.get("authorization") || "";
  if (auth.startsWith("Bearer ")) {
    const { data } = await db.auth.getUser(auth.slice(7).trim()).catch(() => ({ data: { user: null } }) as any);
    const user = data?.user;
    if (user) {
      viewerKey = user.id;
      sessionEpoch = user.last_sign_in_at ?? null;
      isPro = Boolean((await getServerEntitlement(user.id)).isPro);
      displayAnswers = await loadDisplayScoreAnswers(db, user.id, cfEnv);
      const { data: prefs } = await db.from("user_preferences").select(PREFERENCE_ANSWER_COLUMNS).eq("user_id", user.id).maybeSingle();
      if (prefs) answers = answersFromPreferencesRow(prefs);
      if (isOnboardingStep2EnabledServer(cfEnv)) answers.resumeProfile = await loadResumeProfileForRanking(db, user.id);
    }
  }
  const personalized = hasOnboardingAnswers(answers);
  const hasResume = hasResumeSignals(answers.resumeProfile);

  const filters = {
    jobType: filterTokens(searchParams.get("jobType")).sort().join(","),
    workModel: filterTokens(searchParams.get("workModel")).sort().join(","),
    level: formatExperienceLevels(parseExperienceLevels(searchParams.get("level"))),
    datePosted: parseDatePosted(searchParams.get("datePosted")),
    constraints: feedConstraintsFromParams(searchParams),
  };
  const identity = await snapshotIdentity({
    viewerKey,
    sessionEpoch,
    tier: isPro ? "pro" : "free",
    filterIdentity: JSON.stringify(filters),
    answersIdentity: JSON.stringify(answers),
  });

  /** Eligibility, evaluated at build AND serve time. The date window is frozen at the snapshot's build instant. */
  const eligible = (q: any, builtAt: number) => {
    q = q.or(VISIBLE_SOURCE_FILTER).eq("status", "active").eq("is_active", true);
    const jt = jobTypeOrClause(filters.jobType);
    if (jt) q = q.or(jt);
    const wm = workModelOrClause(filters.workModel);
    if (wm) q = q.or(wm);
    if (filters.level) q = applyExperienceLevelQuery(q, filters.level);
    const cutoff = datePostedCutoff(filters.datePosted, builtAt);
    if (cutoff) q = q.gte("posted_at", cutoff);
    return applyFeedConstraints(q, filters.constraints);
  };

  // Ingest epoch: newest first_seen_at among active rows. Every pipeline inserts into jobs and the column defaults to now().
  const { data: epochRow } = await db.from("jobs").select("first_seen_at").eq("status", "active").order("first_seen_at", { ascending: false }).limit(1).maybeSingle();
  const ingestEpoch: string | null = epochRow?.first_seen_at ?? null;

  const buildCols = BASE_COLS + (hasResume ? ", description, skills" : "");
  const prefilter = buildRelevancePrefilter(answers);
  let resolved;
  try {
    resolved = await resolveSnapshot({
      store: prototypeSnapshotStore,
      identity,
      cursor: searchParams.get("cursor"),
      ingestEpoch,
      now: Date.now(),
      build: async (builtAt) => {
        const rows = await loadFullCorpus(async (afterId, lim) => {
          let q = eligible(db.from("jobs").select(buildCols), builtAt);
          if (prefilter) q = q.or(prefilter.orClause);
          if (afterId) q = q.lt("id", afterId);
          const { data, error } = await q.order("id", { ascending: false }).limit(lim);
          if (error) throw new Error(error.message || "corpus read failed");
          return data || [];
        });
        return { ...rankFullCorpus(rows, personalized || hasResume ? answers : null, personalized, builtAt), eligibleRows: rows.length };
      },
    });
  } catch (err) {
    if (err instanceof SnapshotTooLargeError) {
      return json({ error: "snapshot_build_too_large", scannedRows: err.scannedRows, bound: err.bound, jobs: [] }, { status: 503 });
    }
    return json({ error: "Database service unavailable", jobs: [] }, { status: 503 });
  }
  if (resolved.kind === "cursor_reset") return json({ error: "cursor_reset", jobs: [], nextCursor: null, hasNextPage: false }, { status: 409 });

  const { snapshot, position, stale, built } = resolved;
  let page;
  try {
    page = await servePage(snapshot, position, pageSize, async (ids) => {
      const { data, error } = await eligible(db.from("jobs").select(BASE_COLS + (isPro ? PRO_COLS : "")), snapshot.builtAt).in("id", ids);
      if (error) throw new Error(error.message || "page read failed");
      return data || [];
    });
  } catch {
    return json({ error: "Database service unavailable", jobs: [] }, { status: 503 });
  }

  let listGroupIds = new Map<string, string>();
  if (!isPro) {
    try {
      listGroupIds = await buildCompanyGroupIdMap(page.rows.map((r: any) => r.company_id), getRuntimeEnv(COMPANY_GROUP_SECRET_ENV, cfEnv) || process.env[COMPANY_GROUP_SECRET_ENV]);
    } catch {
      return json({ error: "Database service unavailable", jobs: [] }, { status: 503 });
    }
  }
  const ctx = { unmasked: isPro, isPro, listGroupIds, scoreAnswers: displayAnswers || (personalized || hasResume ? answers : null), scoredAt: snapshot.builtAt };
  return json({
    jobs: page.rows.map((row) => formatRecommendedRow(row, ctx)),
    nextCursor: page.hasNextPage ? encodeSnapshotCursor(snapshot.id, page.nextPosition) : null,
    hasNextPage: page.hasNextPage,
    snapshot: { builtAt: new Date(snapshot.builtAt).toISOString(), built, stale, rankedRows: snapshot.jobIds.length, eligibleRows: snapshot.eligibleRows, omittedThisPage: page.omitted },
  });
}
