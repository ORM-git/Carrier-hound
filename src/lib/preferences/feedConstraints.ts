/**
 * Saved feed constraints: the part of UserPreferences the Preferences sheet adds beyond the
 * original contract, and the ONE place that turns them into query predicates.
 *
 * Semantics (shared by /api/jobs/recommended, /api/jobs/search and the client that sends them):
 * - Each dimension is AND-ed with every other active filter.
 * - excludedTitles: a job is hidden when its title contains ANY entry (case-insensitive).
 * - includedCompanies: OR inside the list; a job's company must equal one entry (case-insensitive).
 * - excludedCompanies: a job is hidden when its company equals ANY entry. A name in both lists is
 *   excluded (exclusion wins) and is dropped from the inclusion list before querying.
 * - datePosted: posted_at >= now - window. A job without a source posting date (posted_at NULL,
 *   see #761) never matches an active window: unknown is not "new".
 * The client sends these only for the personalized feed (Recommended tab / match sort), the same
 * scope where saved preferences already apply. Browsing filters stay separate.
 */

export const DATE_POSTED_WINDOWS = ["24h", "3d", "7d", "30d"] as const;
export type DatePostedWindow = (typeof DATE_POSTED_WINDOWS)[number];

const WINDOW_MS: Record<DatePostedWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Canonical window for a stored or URL value (also the older "past week" style labels), else null. */
export function parseDatePosted(value?: string | null): DatePostedWindow | null {
  const v = (value || "").trim().toLowerCase();
  if (!v || v === "all" || v === "any") return null;
  if ((DATE_POSTED_WINDOWS as readonly string[]).includes(v)) return v as DatePostedWindow;
  if (v.includes("24")) return "24h";
  if (v.includes("3")) return v.includes("30") ? "30d" : "3d";
  if (v.includes("7") || v.includes("week")) return "7d";
  if (v.includes("month")) return "30d";
  return null;
}

/** ISO cutoff for posted_at >= cutoff, or null when no window applies. */
export function datePostedCutoff(value?: string | null, now: number = Date.now()): string | null {
  const w = parseDatePosted(value);
  return w ? new Date(now - WINDOW_MS[w]).toISOString() : null;
}

/** The narrower of two windows (a saved preference and a browsing filter both apply: AND). */
export function stricterDatePosted(a?: string | null, b?: string | null): DatePostedWindow | null {
  const wa = parseDatePosted(a);
  const wb = parseDatePosted(b);
  if (!wa || !wb) return wa || wb;
  return WINDOW_MS[wa] <= WINDOW_MS[wb] ? wa : wb;
}

export const WORK_MODELS = ["onsite", "hybrid", "remote"] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

/** Valid, de-duplicated work models in canonical order. */
export function normalizeWorkModels(values: unknown): WorkModel[] {
  const set = new Set(Array.isArray(values) ? values.map((v) => String(v).trim().toLowerCase()) : []);
  return WORK_MODELS.filter((m) => set.has(m));
}

/** Reading a legacy row: the single remote_preference becomes a one-item set; "any"/empty is none. */
export function workModelsFromLegacy(remotePreference?: string | null): WorkModel[] {
  return normalizeWorkModels([remotePreference]);
}

/** The legacy single value written alongside work_models: the one selection, otherwise "any" (never remote-only). */
export function legacyRemotePreference(models: readonly WorkModel[]): WorkModel | "any" {
  return models.length === 1 ? models[0] : "any";
}

export const MAX_LIST_ITEMS = 50;
const MAX_ITEM_LENGTH = 100;

/** Trimmed, whitespace-collapsed, case-insensitively de-duplicated (first spelling kept), capped list. */
export function normalizeTextList(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== "string") continue;
    const v = raw.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_LENGTH);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

export interface SavedFeedConstraints {
  excludedTitles: string[];
  includedCompanies: string[];
  excludedCompanies: string[];
  datePosted: DatePostedWindow | null;
}

/** Normalized constraints with the include/exclude conflict settled (exclusion wins). */
export function normalizeFeedConstraints(input: {
  excludedTitles?: unknown;
  includedCompanies?: unknown;
  excludedCompanies?: unknown;
  datePosted?: string | null;
} | null | undefined): SavedFeedConstraints {
  const excludedCompanies = normalizeTextList(input?.excludedCompanies);
  const excluded = new Set(excludedCompanies.map((c) => c.toLowerCase()));
  return {
    excludedTitles: normalizeTextList(input?.excludedTitles),
    includedCompanies: normalizeTextList(input?.includedCompanies).filter((c) => !excluded.has(c.toLowerCase())),
    excludedCompanies,
    datePosted: parseDatePosted(input?.datePosted),
  };
}

export function hasFeedConstraints(c: SavedFeedConstraints): boolean {
  return Boolean(c.excludedTitles.length || c.includedCompanies.length || c.excludedCompanies.length || c.datePosted);
}

export function companyConstraintsActive(c: SavedFeedConstraints): boolean {
  return Boolean(c.includedCompanies.length || c.excludedCompanies.length);
}

const PARAM = { excludeTitle: "excludeTitle", includeCompany: "includeCompany", excludeCompany: "excludeCompany" };

/** Adds the list constraints to request params (repeated keys, so names with commas survive). */
export function appendFeedConstraintParams(params: URLSearchParams, c: SavedFeedConstraints): void {
  c.excludedTitles.forEach((t) => params.append(PARAM.excludeTitle, t));
  c.includedCompanies.forEach((t) => params.append(PARAM.includeCompany, t));
  c.excludedCompanies.forEach((t) => params.append(PARAM.excludeCompany, t));
}

/** Server side: the list constraints from a request (date posted travels in the existing datePosted param). */
export function feedConstraintsFromParams(params: URLSearchParams): SavedFeedConstraints {
  return normalizeFeedConstraints({
    excludedTitles: params.getAll(PARAM.excludeTitle),
    includedCompanies: params.getAll(PARAM.includeCompany),
    excludedCompanies: params.getAll(PARAM.excludeCompany),
  });
}

// shortcut: characters that could break a PostgREST filter or act as a multi-char wildcard become `_`
// (a single-character wildcard), so "O'Reilly" still matches itself; upgrade to quoted values if a
// collision ever matters.
const likeSafe = (s: string) => s.replace(/[%_(),"'`;\\$*:]/g, "_");

interface FilterableQuery<Q> {
  not(column: string, operator: string, value: unknown): Q;
  or(filters: string): Q;
}

/** Applies the list constraints to a jobs query (before ordering/pagination). Requires the `company` column. */
export function applyFeedConstraints<Q extends FilterableQuery<Q>>(query: Q, c: SavedFeedConstraints): Q {
  let q = query;
  for (const t of c.excludedTitles) q = q.not("title", "ilike", `%${likeSafe(t)}%`);
  for (const name of c.excludedCompanies) q = q.not("company", "ilike", likeSafe(name));
  if (c.includedCompanies.length) {
    q = q.or(c.includedCompanies.map((name) => `company.ilike.${likeSafe(name)}`).join(","));
  }
  return q;
}

/** Client mirror of applyFeedConstraints + the date window, for tests and local predicates. */
export function matchesFeedConstraints(
  job: { title?: string | null; company?: string | null; postedAt?: string | null },
  c: SavedFeedConstraints,
  now: number = Date.now()
): boolean {
  const title = (job.title || "").toLowerCase();
  const company = (job.company || "").toLowerCase();
  if (c.excludedTitles.some((t) => title.includes(t.toLowerCase()))) return false;
  if (c.excludedCompanies.some((n) => company === n.toLowerCase())) return false;
  if (c.includedCompanies.length && !c.includedCompanies.some((n) => company === n.toLowerCase())) return false;
  const cutoff = datePostedCutoff(c.datePosted, now);
  if (cutoff) {
    if (!job.postedAt) return false;
    if (new Date(job.postedAt).getTime() < new Date(cutoff).getTime()) return false;
  }
  return true;
}
